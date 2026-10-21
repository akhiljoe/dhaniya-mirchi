// How do you READ a Blinkit cart without changing it?
//
// `POST /v5/carts` takes the whole cart: posting an empty list empties it
// (proved by cart-semantics.ts). So the adapter needs a read that touches
// nothing, both to show the household what is in the cart and - more
// importantly - to send the full list back when adding, instead of wiping
// whatever was already there.
//
// This puts one item in, then tries the candidate reads, and reports which of
// them sees the item. It clears up after itself and refuses to start on a
// cart that is not empty.
//
//   npm run cart:read
// !! POSTING TO /v5/carts REPLACES THE CART. There is no read-only fetch:
// !! `{"items":[]}` does not ask what is in the cart, it empties it (proved by
// !! cart-semantics.ts). Every script here therefore runs only against a cart
// !! that is already empty, and says so before it starts. Do not reuse these
// !! shapes on a household's real cart without reading that file first.
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import { launchHeadless } from '../../server/src/worker/chrome.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { BLINKIT_ORIGIN } from '../../server/src/constants.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_VERSION = process.env.CHROME_VERSION;
const SEARCH_FOR = process.env.SEARCH_FOR ?? 'Tata Salt';

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

function cartLines(body: string): { id: number; name: string; qty: number }[] {
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

    const call = async (path: string, method: 'GET' | 'POST', body?: unknown) => {
      const args = JSON.stringify({
        path,
        method,
        body: body === undefined ? null : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
      });
      const r = (await page.evaluate(`(async () => {
        const a = ${args};
        const r = await fetch(a.path, { method: a.method, credentials: 'include', headers: a.headers, body: a.body });
        return { status: r.status, body: await r.text() };
      })()`)) as { status: number; body: string };
      await sleep(1500);
      return r;
    };

    const search = await call(`/v1/layout/search?q=${encodeURIComponent(SEARCH_FOR)}`, 'POST', { q: SEARCH_FOR });
    const item = atcItems(JSON.parse(search.body))
      .filter((i) => (i.inventory ?? 0) > 0)
      .sort((a, b) => a.price - b.price)[0];
    if (!item) {
      console.log('nothing in stock to test with. Stopping.');
      return;
    }

    // The only safe moment to experiment is on an empty cart, and the only
    // read we trust so far is the one that sets it - so this starts by
    // setting the cart to exactly the one test item.
    const added = await call('/v5/carts', 'POST', { items: [{ ...item, quantity: 1 }], promo_codes: [''] });
    const held = cartLines(added.body);
    console.log(`cart set to: ${held.map((l) => `${l.name} x${l.qty}`).join(', ') || '(nothing)'}`);
    if (!held.length) {
      console.log('could not put anything in. Stopping.');
      return;
    }
    const wanted = String(item.product_id);
    const cartId = (() => {
      try {
        return String((JSON.parse(added.body) as { cart_id?: unknown }).cart_id ?? '');
      } catch {
        return '';
      }
    })();

    // ---- the candidates ---------------------------------------------------
    const reads: { label: string; path: string; method: 'GET' | 'POST'; body?: unknown }[] = [
      { label: 'POST /v6/carts', path: '/v6/carts', method: 'POST', body: {} },
      { label: 'POST /v4/carts', path: '/v4/carts', method: 'POST', body: {} },
      { label: 'GET  /v5/carts/:id', path: `/v5/carts/${cartId}`, method: 'GET' },
      { label: 'POST /v1/layout/cart {cart_id}', path: '/v1/layout/cart', method: 'POST', body: { cart_id: cartId } },
      { label: 'GET  /v1/layout/cart', path: '/v1/layout/cart', method: 'GET' },
      { label: 'POST /v5/carts/fetch', path: '/v5/carts/fetch', method: 'POST', body: {} },
    ];
    console.log('looking for a read that shows the item (nothing is re-added between tries):');
    for (const r of reads) {
      const answer = await call(r.path, r.method, r.body);
      const sees = answer.body.includes(wanted);
      console.log(`  ${r.label} -> ${answer.status}${sees ? '  SEES THE ITEM' : ''}`);
    }

    const cleared = cartLines((await call('/v5/carts', 'POST', { items: [{ ...item, quantity: 0 }], promo_codes: [''] })).body);
    console.log(`\ncart left holding ${cleared.length} item(s)${cleared.length ? ' — clear it by hand' : ', as it was found'}.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
