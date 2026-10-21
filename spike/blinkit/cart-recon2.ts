// Blinkit cart recon, part 2 — still READ ONLY.
//
// Part 1 found the two calls that matter: the page's own cart is
// `POST /v5/carts` with `{"items":[...],"promo_codes":[""]}`, and search is
// `POST /v1/layout/search?q=…`, both of which our own fetch is allowed to make
// (Instamart refused ours - design Appendix C).
//
// The shape of `items` is what an adapter needs next, and it is not guessable:
// this reads a product out of search and prints every id-shaped field on it,
// with the prices and names it carries, so the add can be written against the
// real thing rather than a hopeful guess.
//
//   SEARCH_FOR="Tata Salt" npm run cart:recon2
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
const OUT_FILE = 'cart-recon2.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every object that looks like a product card, wherever it sits.
function productCards(json: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const tracking = o.tracking as { common_attributes?: Record<string, unknown> } | undefined;
      const attrs = tracking?.common_attributes;
      if (attrs && Object.keys(attrs).some((k) => /product_id|merchant_id|group_id|variant/i.test(k))) out.push(o);
      stack.push(...Object.values(o));
    }
  }
  return out;
}

function shortValue(v: unknown): string {
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; session_sealed: string }>(
    `select id, session_sealed from vendor_connections where vendor = 'blinkit' order by created_at limit 1`,
  );
  const conn = rows[0]!;
  const session = JSON.parse(
    openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`),
  ) as CapturedSession;
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
      await sleep(1200);
      return r;
    };

    console.log(`searching for "${SEARCH_FOR}" (reading only)...`);
    const search = await call(`/v1/layout/search?q=${encodeURIComponent(SEARCH_FOR)}`, 'POST', { q: SEARCH_FOR });
    console.log(`  search -> ${search.status}, ${search.body.length} bytes`);

    console.log('reading the cart the way the page does...');
    const cart = await call('/v5/carts', 'POST', { items: [], promo_codes: [''] });
    console.log(`  /v5/carts -> ${cart.status}, ${cart.body.length} bytes`);

    let cards: Record<string, unknown>[] = [];
    try {
      cards = productCards(JSON.parse(search.body));
    } catch {
      cards = [];
    }

    writeFileSync(OUT_FILE, JSON.stringify({ capturedAt: new Date().toISOString(), searchFor: SEARCH_FOR, search: search.body, cart: cart.body }, null, 2));

    console.log(`\n[ok] ${cards.length} product cards in the search answer → ${OUT_FILE}`);
    for (const card of cards.slice(0, 3)) {
      const data = (card.data ?? {}) as Record<string, unknown>;
      const attrs = ((card.tracking as { common_attributes?: Record<string, unknown> })?.common_attributes ?? {}) as Record<string, unknown>;
      console.log(`\n--- a product card ---`);
      console.log(`  identity: ${shortValue(data.identity)}`);
      console.log(`  name:     ${shortValue((data.name as { text?: unknown })?.text ?? (data.title as { text?: unknown })?.text)}`);
      console.log(`  ids on it: ${Object.entries(attrs).filter(([k]) => /id|variant|merchant|group|type/i.test(k)).map(([k, v]) => `${k}=${shortValue(v)}`).join(', ')}`);
      const actionKeys = Object.keys(data).filter((k) => /action|atc|add/i.test(k));
      console.log(`  action-ish fields: ${actionKeys.join(', ') || '(none)'}`);
      for (const k of actionKeys) console.log(`    ${k}: ${shortValue(data[k])}`);
    }

    // What the cart itself says about how it is changed.
    try {
      const cartJson = JSON.parse(cart.body) as Record<string, unknown>;
      console.log(`\n--- the cart answer ---`);
      console.log(`  top-level keys: ${Object.keys(cartJson).join(', ')}`);
      const asText = JSON.stringify(cartJson);
      for (const hint of ['update_cart', 'cart_request_body', 'item_count_modify', 'add_to_cart', 'atc']) {
        const at = asText.indexOf(hint);
        if (at >= 0) console.log(`  mentions "${hint}": ${asText.slice(at, at + 160)}…`);
      }
    } catch {
      console.log('  (cart answer was not JSON)');
    }
    console.log(`\n${OUT_FILE} holds the cart and search answers. Gitignored.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
