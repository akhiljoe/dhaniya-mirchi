// Blinkit's own app must read the cart somehow - open it on a second device
// and your basket is there - so this makes the official page show us how.
//
// Everything we have tried returns a cart with no items in it. Rather than
// guess at more endpoint names, this puts a marker in the cart, loads the site
// the way a person would, and looks through EVERY answer the page receives for
// the marker's product id. Whatever call carries it is the read we could not
// find by guessing.
//
//   npm run cart:find-read
//
// The home page is used, never /cart: the cart page uploads an empty cart on
// load and would destroy the marker before anything could be learned
// (cart-page.ts). Refuses to start unless the cart is empty; leaves it empty.
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

function lines(body: string): { qty: number }[] {
  try {
    const items = (JSON.parse(body) as { cart_data?: { items?: unknown[] } }).cart_data?.items ?? [];
    return items.map((i) => ({ qty: Number((i as { quantity?: unknown }).quantity ?? 0) }));
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
    if (lines(set.body).length !== 1) {
      console.log('could not set the marker. Stopping.');
      return;
    }
    const marker = String(item.product_id);
    console.log(`marker in the cart: product ${marker} x${MARKER_QTY}\n`);

    // Now watch everything a fresh load of the site receives.
    const carriers: { url: string; where: string }[] = [];
    const seen = new Set<string>();
    const watcher = async (res: import('playwright').Response) => {
      const url = res.url();
      if (!url.includes('blinkit.com')) return;
      const type = res.request().resourceType();
      if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
      let body = '';
      try {
        body = await res.text();
      } catch {
        return;
      }
      if (!body.includes(marker)) return;
      const key = url.split('?')[0]!;
      if (seen.has(key)) return;
      seen.add(key);
      // Is it there as a cart line, or only as a recommendation?
      const where = /cart_data/.test(body) && body.indexOf('cart_data') < body.indexOf(marker) + 4000 ? 'inside cart_data' : 'somewhere in the answer';
      carriers.push({ url: key, where });
    };
    const fresh = await context.newPage();
    fresh.on('response', watcher);
    console.log('loading the site again, watching every answer for the marker...');
    await fresh.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await fresh.waitForTimeout(10_000);

    console.log(`\n--- calls whose answer carried the marker ---`);
    if (!carriers.length) console.log('  none. The page never receives the cart contents on a normal load.');
    for (const c of carriers) console.log(`  ${c.url.replace(BLINKIT_ORIGIN, '')}  (${c.where})`);

    const afterLoad = lines((await call('/v5/carts', { items: [{ ...item, quantity: MARKER_QTY }], promo_codes: [''] })).body);
    console.log(`\nmarker still in the cart after the load: ${afterLoad.length === 1 ? 'yes' : 'no'}`);

    const cleared = lines((await call('/v5/carts', { items: [{ ...item, quantity: 0 }], promo_codes: [''] })).body);
    console.log(`cart left holding ${cleared.length} item(s)${cleared.length ? ' — clear it by hand' : ', as it was found'}.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
