// The test the whole Blinkit cart feature rests on.
//
// Our fetch can set the cart, but Blinkit's WEB client never reads the server
// copy: it pushes its own local one (cart-find-read.ts). If the phone app does
// the same, then anything we put in is overwritten the moment the household
// opens Blinkit, and the feature is worthless however well it is built. If the
// phone pulls, our adds stick and it is worth building.
//
// Only a phone can answer, so this puts one cheap item in and LEAVES IT THERE,
// unlike every other script here.
//
//   npm run cart:phone-test           # put the item in
//   CLEAR=1 npm run cart:phone-test   # take it out again afterwards
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import { launchHeadless } from '../../server/src/worker/chrome.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { BLINKIT_ORIGIN } from '../../server/src/constants.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_VERSION = process.env.CHROME_VERSION;
const SEARCH_FOR = process.env.SEARCH_FOR ?? 'Tata Salt';
const CLEAR = process.env.CLEAR === '1';

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

function lines(body: string): { name: string; qty: number }[] {
  try {
    const items = (JSON.parse(body) as { cart_data?: { items?: unknown[] } }).cart_data?.items ?? [];
    return items.map((i) => {
      const o = i as Record<string, unknown>;
      return { name: String(o.name ?? '?'), qty: Number(o.quantity ?? 0) };
    });
  } catch {
    return [];
  }
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; phone_last4: string; session_sealed: string }>(
    `select id, phone_last4, session_sealed from vendor_connections where vendor = 'blinkit' order by created_at limit 1`,
  );
  const conn = rows[0]!;
  const session = JSON.parse(openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
  await db.end();
  console.log(`the account ending ${conn.phone_last4}`);

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
      .filter((i) => (i.inventory ?? 0) > 0)
      .sort((a, b) => a.price - b.price)[0];
    if (!item) {
      console.log('nothing in stock to test with. Stopping.');
      return;
    }

    if (CLEAR) {
      const cleared = lines((await call('/v5/carts', { items: [{ ...item, quantity: 0 }], promo_codes: [''] })).body);
      console.log(`cart now holds ${cleared.length} item(s).`);
      return;
    }

    const set = await call('/v5/carts', { items: [{ ...item, quantity: 1 }], promo_codes: [''] });
    const held = lines(set.body);
    console.log(`\nput in the cart: ${held.map((l) => `${l.name} x${l.qty}`).join(', ') || '(nothing)'}`);
    console.log(`  ${item.product_name}`);
    console.log(`  ${item.unit}, Rs ${item.price}`);
    console.log('\nNow open Blinkit on the phone and look at the cart.');
    console.log('  it is there      -> the app reads the server, our adds stick, build it');
    console.log('  it is empty      -> the app pushes its own copy and overwrites ours');
    console.log('\nNothing will be ordered: an item in a cart is not a purchase.');
    console.log('Afterwards: CLEAR=1 npm run cart:phone-test');
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
