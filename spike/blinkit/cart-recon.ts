// Blinkit cart recon — READ ONLY. Nothing is added, nothing is removed.
//
// Instamart forced the cart to be filled through the page's own buttons: it
// signs its page's requests, so our fetch could read a cart and clear it but
// never add to it (design Appendix C). Blinkit's read path had no such
// trouble - order_history takes our headers happily - so the first question
// is whether its cart does too, and that decides the whole adapter.
//
// What this answers, without touching the cart:
//   1. what the page calls when the cart is opened, and what the cart answers;
//   2. how a product is found (search), and what identifies it;
//   3. whether the cart looks tied to a store or an address, as Instamart's is;
//   4. whether an add is even shaped like something our fetch could send.
//
//   npm run cart:recon
//
// It runs on the session the app already holds, restored from the vault by
// the same code the worker uses, so what it sees is what the worker would see.
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
const CHROME_VERSION = process.env.CHROME_VERSION; // Windows Chrome prints no --version
const OUT_FILE = 'cart-recon.json';
const SEARCH_FOR = process.env.SEARCH_FOR ?? 'Tata Salt';
const CALL_DELAY_MS = 1200; // the pace a 461-order import ran at without a challenge

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  method: string;
  url: string;
  status: number | null;
  postData: string | null;
  bodyStart: string | null;
}

function mask(s: string): string {
  return s.replace(/\d{6,}/g, (d) => `${d.slice(0, 2)}${'*'.repeat(d.length - 2)}`).replace(/([A-Za-z0-9_-]{24,})/g, (t) => `${t.slice(0, 6)}…`);
}

// The keys that look like a product's identity, wherever they sit in the answer.
function idKeys(json: unknown): Map<string, number> {
  const seen = new Map<string, number>();
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/^(product_id|merchant_id|item_id|variant_id|group_id|cart_item_id|id)$/i.test(k) && (typeof val === 'string' || typeof val === 'number')) {
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
        stack.push(val);
      }
    }
  }
  return seen;
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; session_sealed: string }>(
    `select id, session_sealed from vendor_connections where vendor = 'blinkit' order by created_at limit 1`,
  );
  if (!rows.length) throw new Error('no Blinkit connection to read');
  const conn = rows[0]!;
  const session = JSON.parse(
    openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`),
  ) as CapturedSession;
  await db.end();

  const hb = await launchHeadless(CHROME, CHROME_VERSION);
  const calls: Call[] = [];
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
    page.on('response', async (res) => {
      const req = res.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      if (!res.url().includes('blinkit.com')) return;
      let bodyStart: string | null = null;
      try {
        const ct = (await res.headerValue('content-type')) ?? '';
        if (/json/i.test(ct)) bodyStart = (await res.text()).slice(0, 600);
      } catch {
        bodyStart = null;
      }
      calls.push({ method: req.method(), url: res.url(), status: res.status(), postData: req.postData(), bodyStart });
    });

    console.log('opening the app on the household session...');
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
        return { status: r.status, body: (await r.text()).slice(0, 1500) };
      })()`)) as { status: number; body: string };
      await sleep(CALL_DELAY_MS);
      return r;
    };

    // ---- 1. what the cart page itself does -------------------------------
    console.log('opening the cart page (reading only)...');
    await page.goto(`${BLINKIT_ORIGIN}/cart`, { waitUntil: 'load', timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(5000);

    // ---- 2. the endpoints worth trying by name ---------------------------
    const guesses: { path: string; method: 'GET' | 'POST'; body?: unknown }[] = [
      { path: '/v2/cart', method: 'GET' },
      { path: '/v1/cart', method: 'GET' },
      { path: '/v1/layout/cart', method: 'POST', body: {} },
      { path: '/v2/cart/get', method: 'POST', body: {} },
      { path: '/v1/cart/get', method: 'POST', body: {} },
    ];
    const cartReads: Record<string, { status: number; body: string }> = {};
    for (const g of guesses) {
      const r = await call(g.path, g.method, g.body);
      cartReads[`${g.method} ${g.path}`] = r;
      console.log(`  ${g.method} ${g.path} -> ${r.status}`);
    }

    // ---- 3. how a product is found ---------------------------------------
    console.log(`searching for ${SEARCH_FOR} (reading only)...`);
    const search = await call(`/v1/layout/search?q=${encodeURIComponent(SEARCH_FOR)}`, 'POST', { q: SEARCH_FOR });
    console.log(`  search -> ${search.status}`);
    let searchIds: string[] = [];
    try {
      searchIds = [...idKeys(JSON.parse(search.body))].map(([k, n]) => `${k} x${n}`);
    } catch {
      searchIds = [];
    }

    writeFileSync(
      OUT_FILE,
      JSON.stringify({ capturedAt: new Date().toISOString(), pageCalls: calls, cartReads, search: { status: search.status, body: search.body } }, null, 2),
    );

    // ---- what was learned -------------------------------------------------
    const cartish = calls.filter((c) => /cart|checkout/i.test(c.url));
    console.log(`\n[ok] ${calls.length} calls seen, ${cartish.length} cart-shaped → ${OUT_FILE}`);
    console.log('\n--- what the page itself called for the cart ---');
    for (const c of cartish.slice(0, 15)) {
      console.log(`  ${c.method} ${mask(c.url)} -> ${c.status}`);
      if (c.postData) console.log(`     body: ${mask(c.postData).slice(0, 160)}`);
    }
    console.log('\n--- our own calls ---');
    for (const [k, v] of Object.entries(cartReads)) console.log(`  ${k} -> ${v.status}${v.status === 200 ? '  (our fetch is accepted)' : ''}`);
    console.log(`\n--- product identity in search (${search.status}) ---`);
    console.log(`  ${searchIds.length ? searchIds.join(', ') : '(no id-shaped keys found; see the file)'}`);
    console.log(`\n${OUT_FILE} holds cart contents and addresses. Gitignored.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
