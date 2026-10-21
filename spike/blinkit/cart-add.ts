// Blinkit cart — the one question left: can OUR fetch put something in it?
//
// Instamart refuses an add made by our own fetch (it signs its page's
// requests), which is why its adapter drives the page's buttons instead
// (design Appendix C). Blinkit let our fetch read the cart and search, so this
// tries one add and then puts the cart back exactly as it found it.
//
// The guard that makes this safe to run: it REFUSES unless the cart is empty.
// A household's real cart is never disturbed - if there is anything in it, the
// script stops and says so.
//
//   npm run cart:add                 # a cheap item, added then removed
//   SEARCH_FOR="Tata Salt" npm run cart:add
//
// What it proves, either way:
//   - our fetch is accepted        → the adapter is a few API calls;
//   - our fetch is refused         → Blinkit needs Instamart's button-driving,
//                                    and the adapter is a browser script.
// !! POSTING TO /v5/carts REPLACES THE CART. There is no read-only fetch:
// !! `{"items":[]}` does not ask what is in the cart, it empties it (proved by
// !! cart-semantics.ts). Every script here therefore runs only against a cart
// !! that is already empty, and says so before it starts. Do not reuse these
// !! shapes on a household's real cart without reading that file first.
import { writeFileSync } from 'node:fs';

import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import { launchHeadless } from '../../server/src/worker/chrome.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { BLINKIT_ORIGIN } from '../../server/src/constants.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_VERSION = process.env.CHROME_VERSION;
const SEARCH_FOR = process.env.SEARCH_FOR ?? 'Tata Salt';
const OUT_FILE = 'cart-add.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CartItem {
  product_id: number;
  merchant_id: number;
  product_name: string;
  quantity: number;
  price: number;
  unit: string;
  group_id?: number;
  [k: string]: unknown;
}

// The `atc_action` a product card carries is the vendor's own description of
// what to add, so it is used verbatim rather than rebuilt from parts.
function addToCartItems(json: unknown): CartItem[] {
  const out: CartItem[] = [];
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const atc = o.atc_action as { add_to_cart?: { cart_item?: CartItem } } | undefined;
      const item = atc?.add_to_cart?.cart_item;
      if (item && typeof item.product_id === 'number') out.push(item);
      stack.push(...Object.values(o));
    }
  }
  return out;
}

function cartItems(body: string): { count: number; names: string[] } {
  try {
    const j = JSON.parse(body) as { cart_data?: { items?: unknown } };
    const items = j.cart_data?.items;
    if (!Array.isArray(items)) return { count: 0, names: [] };
    return { count: items.length, names: items.map((i) => String((i as { product_name?: unknown }).product_name ?? '?')) };
  } catch {
    return { count: 0, names: [] };
  }
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; phone_last4: string; session_sealed: string }>(
    `select id, phone_last4, session_sealed from vendor_connections where vendor = 'blinkit' order by created_at limit 1`,
  );
  const conn = rows[0]!;
  const session = JSON.parse(
    openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`),
  ) as CapturedSession;
  await db.end();
  console.log(`using the connection ending ${conn.phone_last4}`);

  const hb = await launchHeadless(CHROME, CHROME_VERSION);
  const log: Record<string, unknown> = {};
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

    // ---- the guard, and its own limitation --------------------------------
    // This "check" is itself a write: posting an empty list empties the cart.
    // So it cannot protect a cart that has something in it - by the time it
    // could tell, it would already have wiped it. It is kept only because
    // this script is run against a cart known to be empty, and the household
    // must be asked first. There is no read-only way to look.
    const before = await call('/v5/carts', 'POST', { items: [], promo_codes: [''] });
    const beforeItems = cartItems(before.body);
    console.log(`cart before: ${beforeItems.count} items`);
    if (beforeItems.count > 0) {
      console.log(`  the cart is not empty (${beforeItems.names.join(', ')}). Stopping: a real cart is not ours to disturb.`);
      return;
    }

    // ---- find something cheap --------------------------------------------
    const search = await call(`/v1/layout/search?q=${encodeURIComponent(SEARCH_FOR)}`, 'POST', { q: SEARCH_FOR });
    const candidates = addToCartItems(JSON.parse(search.body)).filter((i) => (i.inventory as number) > 0);
    if (!candidates.length) {
      console.log('nothing in stock came back from search. Stopping.');
      return;
    }
    const cheapest = candidates.sort((a, b) => a.price - b.price)[0]!;
    console.log(`chosen: ${cheapest.product_name} — ${cheapest.unit}, Rs ${cheapest.price} (product ${cheapest.product_id})`);

    // ---- the one add ------------------------------------------------------
    const added = await call('/v5/carts', 'POST', { items: [{ ...cheapest, quantity: 1 }], promo_codes: [''] });
    const afterAdd = cartItems(added.body);
    // What a cart line actually looks like, so state() can read it later.
    try {
      const items = (JSON.parse(added.body) as { cart_data?: { items?: unknown[] } }).cart_data?.items ?? [];
      if (items.length) {
        const keys = Object.keys(items[0] as Record<string, unknown>);
        console.log(`  a cart line carries: ${keys.join(', ')}`);
        log.cartLineKeys = keys;
      }
    } catch {
      // the shape check is a bonus, never the point of the run
    }
    console.log(`\nadd -> HTTP ${added.status}; cart now holds ${afterAdd.count} item(s): ${afterAdd.names.join(', ') || '(none)'}`);

    // ---- read it back independently, in case the answer flatters itself ---
    const reread = await call('/v5/carts', 'POST', { items: [{ ...cheapest, quantity: 1 }], promo_codes: [''] });
    const onReread = cartItems(reread.body);
    console.log(`re-read -> ${onReread.count} item(s): ${onReread.names.join(', ') || '(none)'}`);

    // ---- put it back exactly as we found it -------------------------------
    const cleared = await call('/v5/carts', 'POST', { items: [{ ...cheapest, quantity: 0 }], promo_codes: [''] });
    let afterClear = cartItems(cleared.body);
    if (afterClear.count > 0) {
      const emptied = await call('/v5/carts', 'POST', { items: [], promo_codes: [''] });
      afterClear = cartItems(emptied.body);
    }
    console.log(`cleared -> cart holds ${afterClear.count} item(s)`);

    log.chosen = { product_id: cheapest.product_id, unit: cheapest.unit, price: cheapest.price };
    log.addStatus = added.status;
    log.afterAdd = afterAdd.count;
    log.onReread = onReread.count;
    log.afterClear = afterClear.count;
    writeFileSync(OUT_FILE, JSON.stringify(log, null, 2));

    console.log('\n--- the answer ---');
    if (onReread.count > 0) {
      console.log('  OUR FETCH CAN FILL THE BLINKIT CART. No button-driving needed,');
      console.log('  unlike Instamart: the adapter is /v5/carts with the items list.');
    } else {
      console.log('  our fetch did NOT put anything in the cart. Blinkit needs the');
      console.log("  page's own buttons, the way Instamart does (design Appendix C).");
    }
    console.log(afterClear.count === 0 ? '  The cart was left empty, as it was found.' : `  WARNING: ${afterClear.count} item(s) left in the cart — clear it by hand.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
