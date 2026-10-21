// Is there any way to LOOK at a Blinkit cart without rewriting it?
//
// Everything tried so far posted `items: []`, which is not a question but an
// instruction: the cart becomes nothing (cart-semantics.ts). This tries the
// shapes that leave `items` out altogether, on the chance that the field is
// optional and the answer still carries the cart.
//
// The marker is the quantity: the cart is set to THREE of one item first, so
// a candidate's own answer proves what happened. Three of them back means it
// read without touching anything. An empty answer means it wiped, and that
// candidate is disqualified for good.
//
//   npm run cart:peek
//
// Refuses to start unless the cart is empty, and leaves it empty.
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import { launchHeadless } from '../../server/src/worker/chrome.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { BLINKIT_ORIGIN } from '../../server/src/constants.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_VERSION = process.env.CHROME_VERSION;
const SEARCH_FOR = process.env.SEARCH_FOR ?? 'Tata Salt';
const MARKER_QTY = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CartItem {
  product_id: number;
  quantity: number;
  price: number;
  unit: string;
  product_name: string;
  inventory?: number;
  [k: string]: unknown;
}

function atcItems(json: unknown): CartItem[] {
  const out: CartItem[] = [];
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const item = (o.atc_action as { add_to_cart?: { cart_item?: CartItem } } | undefined)?.add_to_cart?.cart_item;
      if (item && typeof item.product_id === 'number') out.push(item);
      stack.push(...Object.values(o));
    }
  }
  return out;
}

function lines(body: string): { id: number; name: string; qty: number }[] {
  try {
    const items = (JSON.parse(body) as { cart_data?: { items?: unknown[] } }).cart_data?.items ?? [];
    return items.map((i) => {
      const o = i as Record<string, unknown>;
      return { id: Number(o.product_id), name: String(o.name ?? '?'), qty: Number(o.quantity ?? 0) };
    });
  } catch {
    return [];
  }
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; session_sealed: string }>(
    `select id, session_sealed from vendor_connections where vendor = 'blinkit' order by created_at limit 1`,
  );
  const conn = rows[0]!;
  const session = JSON.parse(openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
  await db.end();

  const hb = await launchHeadless(CHROME, CHROME_VERSION);
  try {
    const context = hb.browser.contexts()[0]!;
    await context.addCookies(
      session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
      })),
    );
    await context.addInitScript(
      `if (location.origin === ${JSON.stringify(BLINKIT_ORIGIN)}) {
         const s = ${JSON.stringify(session.localStorage)};
         for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
       }`,
    );
    const page = await context.newPage();
    let headers: Record<string, string> = {};
    page.on('request', (req) => {
      const h = req.headers();
      if (req.url().includes('/v1/') && h.auth_key && h.access_token) headers = h;
    });
    await page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(6000);

    const call = async (path: string, body: unknown) => {
      const args = JSON.stringify({ path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
      const r = (await page.evaluate(`(async () => {
        const a = ${args};
        const r = await fetch(a.path, { method: 'POST', credentials: 'include', headers: a.headers, body: a.body });
        return { status: r.status, body: await r.text() };
      })()`)) as { status: number; body: string };
      await sleep(1500);
      return r;
    };

    const search = await call(`/v1/layout/search?q=${encodeURIComponent(SEARCH_FOR)}`, { q: SEARCH_FOR });
    const item = atcItems(JSON.parse(search.body))
      .filter((i) => (i.inventory ?? 0) >= MARKER_QTY)
      .sort((a, b) => a.price - b.price)[0];
    if (!item) {
      console.log('nothing with enough stock to mark with. Stopping.');
      return;
    }

    const set = await call('/v5/carts', { items: [{ ...item, quantity: MARKER_QTY }], promo_codes: [''] });
    const held = lines(set.body);
    console.log(`marker set: ${held.map((l) => `${l.name} x${l.qty}`).join(', ') || '(nothing)'}`);
    if (!held.length || held[0]!.qty !== MARKER_QTY) {
      console.log('could not set the marker. Stopping.');
      return;
    }
    const cartId = (() => {
      try {
        return (JSON.parse(set.body) as { cart_id?: unknown }).cart_id;
      } catch {
        return undefined;
      }
    })();

    const candidates: { label: string; body: unknown }[] = [
      { label: '{} (no items key at all)', body: {} },
      { label: '{promo_codes} only', body: { promo_codes: [''] } },
      { label: '{items: null}', body: { items: null } },
      { label: '{cart_id}', body: { cart_id: cartId } },
    ];

    console.log(`\nasking /v5/carts without telling it the items (marker is x${MARKER_QTY}):`);
    for (const c of candidates) {
      const answer = await call('/v5/carts', c.body);
      const got = lines(answer.body);
      const keptMarker = got.length === 1 && got[0]!.qty === MARKER_QTY;
      console.log(`  ${c.label} -> ${answer.status}, answer holds ${got.length ? got.map((l) => `x${l.qty}`).join(',') : 'nothing'}${keptMarker ? '   <== READS WITHOUT WIPING' : ''}`);
      // Put the marker back for the next candidate, whatever happened.
      await call('/v5/carts', { items: [{ ...item, quantity: MARKER_QTY }], promo_codes: [''] });
    }

    const cleared = lines((await call('/v5/carts', { items: [{ ...item, quantity: 0 }], promo_codes: [''] })).body);
    console.log(`\ncart left holding ${cleared.length} item(s)${cleared.length ? ' — clear it by hand' : ', as it was found'}.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
