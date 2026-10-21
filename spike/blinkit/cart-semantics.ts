// What does `items` mean to POST /v5/carts?
//
// Two readings, and the difference is somebody's shopping:
//   a) a list of CHANGES  - "set these products to these quantities", and
//      everything else in the cart is left alone. Reading the cart by posting
//      an empty list is then safe.
//   b) the WHOLE CART     - "the cart is now exactly this", so posting an
//      empty list to read it would silently empty the household's cart.
//
// The page always posts its own full list, so watching it cannot tell the two
// apart. This can: put one item in, post an empty list, and see whether the
// item is still there.
//
//   npm run cart:semantics
//
// It refuses unless the cart starts empty, and puts it back empty at the end.
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

    const start = await call('/v5/carts', { items: [], promo_codes: [''] });
    if (lines(start.body).length) {
      console.log('the cart is not empty. Stopping: a real cart is not ours to experiment on.');
      return;
    }
    console.log('cart starts empty.');

    const search = await call(`/v1/layout/search?q=${encodeURIComponent(SEARCH_FOR)}`, { q: SEARCH_FOR });
    const item = atcItems(JSON.parse(search.body))
      .filter((i) => (i.inventory ?? 0) > 0)
      .sort((a, b) => a.price - b.price)[0];
    if (!item) {
      console.log('nothing in stock to test with. Stopping.');
      return;
    }
    console.log(`putting one in: ${item.product_name} (${item.unit}, Rs ${item.price})`);
    const added = await call('/v5/carts', { items: [{ ...item, quantity: 1 }], promo_codes: [''] });
    const afterAdd = lines(added.body);
    console.log(`  cart holds: ${afterAdd.map((l) => `${l.name} x${l.qty}`).join(', ') || '(nothing)'}`);
    if (!afterAdd.length) {
      console.log('  the add did not take. Stopping before drawing conclusions.');
      return;
    }

    console.log('\nnow posting an EMPTY items list, which is how a read would be written...');
    const empty = await call('/v5/carts', { items: [], promo_codes: [''] });
    const afterEmpty = lines(empty.body);
    console.log(`  cart holds: ${afterEmpty.map((l) => `${l.name} x${l.qty}`).join(', ') || '(nothing)'}`);

    console.log('\n--- the answer ---');
    if (afterEmpty.length === afterAdd.length) {
      console.log('  `items` is a list of CHANGES. An empty list reads the cart and');
      console.log('  changes nothing, so state() can post [] safely.');
    } else {
      console.log('  `items` REPLACES the cart: posting [] emptied it. state() must');
      console.log('  never post an empty list - it would wipe the cart.');
    }

    // Leave it as we found it either way.
    const cleared = await call('/v5/carts', { items: [{ ...item, quantity: 0 }], promo_codes: [''] });
    const left = lines(cleared.body);
    console.log(`\ncart left holding ${left.length} item(s)${left.length ? ' — clear it by hand' : ', as it was found'}.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
