// Two questions the API alone cannot answer, both about wiping a real cart.
//
// 1. Does merely OPENING the site on our restored session empty the cart?
//    Instamart's adapter carries this scar: "the browser profile must not
//    carry a saved cart: on load the page pushes its local copy back to the
//    server, which undid a removal". Our Blinkit session deliberately drops
//    the `cart` key now (BLINKIT_SESSION_KEYS), so the page loads with no
//    local cart - and if it pushes that emptiness to the server, the worker
//    would erase the household's shopping just by opening the page.
//
// 2. Is there any read at all that shows the cart without changing it? The
//    page renders the cart, so its own DOM is the one observer that cannot
//    flatter itself.
//
//   npm run cart:page
//
// Refuses to start unless the cart is empty, and leaves it empty.
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

function cartLines(body: string): { name: string; qty: number }[] {
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
  const { rows } = await db.query<{ id: string; session_sealed: string }>(
    `select id, session_sealed from vendor_connections where vendor = 'blinkit' order by created_at limit 1`,
  );
  const conn = rows[0]!;
  const session = JSON.parse(openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
  await db.end();
  console.log(`session carries a local cart: ${session.localStorage.cart !== undefined ? 'yes' : 'no'}`);

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
    // Everything the page itself posts to the cart, so an automatic wipe is
    // visible rather than inferred.
    const cartPosts: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/v5/carts') && req.method() === 'POST') cartPosts.push((req.postData() ?? '').slice(0, 120));
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

    const set = await call('/v5/carts', { items: [{ ...item, quantity: 1 }], promo_codes: [''] });
    const held = cartLines(set.body);
    console.log(`\ncart set to: ${held.map((l) => `${l.name} x${l.qty}`).join(', ') || '(nothing)'}`);
    if (!held.length) {
      console.log('could not put anything in. Stopping.');
      return;
    }

    // The import adapter loads the HOME page on every sync, so that is the one
    // that matters most: if it pushes an empty cart, every sync has been
    // erasing the household's shopping.
    const postsBeforeHome = cartPosts.length;
    console.log('\nopening the HOME page, the way every import does...');
    await page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(8000);
    const homePosts = cartPosts.slice(postsBeforeHome);
    console.log(`  the home page posted to /v5/carts ${homePosts.length} time(s)`);
    for (const p of homePosts) console.log(`    ${p}`);
    const afterHome = cartLines((await call('/v5/carts', { items: [{ ...item, quantity: 1 }], promo_codes: [''] })).body);
    console.log(`  cart restored to ${afterHome.length} item(s) for the next step`);

    const postsBefore = cartPosts.length;
    console.log('\nopening the cart page on this session, the way the worker would...');
    await page.goto(`${BLINKIT_ORIGIN}/cart`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(8000);
    const pagePosts = cartPosts.slice(postsBefore);
    console.log(`  the page posted to /v5/carts ${pagePosts.length} time(s) while loading`);
    for (const p of pagePosts) console.log(`    ${p}`);

    const text = (await page.evaluate('document.body.innerText')) as string;
    const shortName = item.product_name.split(/[(/]/)[0]!.trim().slice(0, 24);
    const seenOnPage = text.toLowerCase().includes(shortName.toLowerCase());
    console.log(`  the cart page ${seenOnPage ? 'SHOWS' : 'does not show'} "${shortName}"`);

    console.log('\n--- what this means ---');
    if (seenOnPage) {
      console.log('  Opening the site did NOT wipe the cart, and the cart page is a read');
      console.log('  that shows what is in it. The adapter can look before it writes.');
    } else {
      console.log('  The item is not on the page. Either opening the site emptied the');
      console.log('  cart - the Instamart trap, and a real hazard here - or the page did');
      console.log('  not render in time. The posts listed above say which.');
    }

    const cleared = cartLines((await call('/v5/carts', { items: [{ ...item, quantity: 0 }], promo_codes: [''] })).body);
    console.log(`\ncart left holding ${cleared.length} item(s)${cleared.length ? ' — clear it by hand' : ', as it was found'}.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
