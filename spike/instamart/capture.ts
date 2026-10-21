// Instamart recon — STEP 1: record.
//
// Unlike Blinkit, we didn't know which endpoint serves Instamart order history
// (Swiggy is a different stack from Blinkit's Zomato "Crystal"). So this is a
// network recorder, not a targeted interceptor: it opens your real Chrome, YOU
// sign into instamart.in (phone + OTP) and click through to your orders, and
// every JSON response from a swiggy.com / instamart.in host is appended to
// net_log.jsonl. Close the window when done; a summary of endpoints prints.
//
// This runs on YOUR machine against YOUR account. net_log.jsonl contains live
// session headers and real order data (with address) — it is gitignored.
//
//   npm run capture
//
// Uses your installed Google Chrome (override with CHROME_PATH), in a
// dedicated profile (.chromedata) so the login persists for `npm run extract`.
//
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { Response } from 'playwright';
import { attachChrome } from './shared.ts';

const LOG_FILE = 'net_log.jsonl';
const MAX_BODY_CHARS = 3_000_000;

// Keywords that suggest a response carries order history. Only used to rank
// the summary — every JSON response from a recorded host is kept regardless.
const ORDER_HINTS = /order_?id|orderId|order_items|itemsDetails|order_time|ordered_time|delivered_time/;

interface NetRecord {
  t: string; // ISO time the response arrived
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  postData: string | null;
  body: string;
  bodyTruncated: boolean;
}

// Instamart lives on its own domain (instamart.in) as well as under
// swiggy.com/instamart — same app bundle, separate login per domain.
const HOSTS = ['swiggy.com', 'instamart.in'];

function isRecordedHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function record(res: Response): Promise<void> {
  const req = res.request();
  const type = req.resourceType();
  if (type !== 'xhr' && type !== 'fetch') return;
  if (!isRecordedHost(req.url())) return;
  const ct = res.headers()['content-type'] ?? '';
  if (!ct.includes('json')) return;
  let body: string;
  try {
    body = await res.text();
  } catch {
    return; // body unavailable (redirect / page navigated away)
  }
  const rec: NetRecord = {
    t: new Date().toISOString(),
    method: req.method(),
    url: req.url(),
    status: res.status(),
    requestHeaders: await req.allHeaders(),
    postData: req.postData(),
    body: body.slice(0, MAX_BODY_CHARS),
    bodyTruncated: body.length > MAX_BODY_CHARS,
  };
  appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
  const flag = ORDER_HINTS.test(body) ? '  <-- order-like' : '';
  console.log(`[rec] ${rec.status} ${rec.method} ${new URL(rec.url).pathname}${flag}`);
}

function summarize(): void {
  if (!existsSync(LOG_FILE)) {
    console.log('\nNothing recorded.');
    return;
  }
  const byPath = new Map<string, { n: number; orderLike: number; methods: Set<string>; maxBytes: number }>();
  for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as NetRecord;
    const u = new URL(r.url);
    const key = `${u.hostname}${u.pathname}`;
    const s = byPath.get(key) ?? { n: 0, orderLike: 0, methods: new Set<string>(), maxBytes: 0 };
    s.n++;
    s.methods.add(r.method);
    s.maxBytes = Math.max(s.maxBytes, r.body.length);
    if (ORDER_HINTS.test(r.body)) s.orderLike++;
    byPath.set(key, s);
  }
  const rows = [...byPath.entries()].sort((a, b) => b[1].orderLike - a[1].orderLike || b[1].maxBytes - a[1].maxBytes);
  console.log('\n--- endpoints seen (order-like first) ---');
  for (const [path, s] of rows) {
    console.log(
      `${String(s.orderLike).padStart(3)}/${String(s.n).padEnd(3)} ${[...s.methods].join(',').padEnd(8)} ` +
        `${String(Math.round(s.maxBytes / 1024)).padStart(6)} KB  ${path}`,
    );
  }
  console.log(`\nFull log: ${LOG_FILE} (gitignored — contains live session headers + PII).`);
}

async function main() {
  // Each run is a fresh recording; the login itself persists in .chromedata.
  if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);

  // Attaches to the spike Chrome (launching it if needed) — see shared.ts for
  // why Playwright must not launch the browser itself.
  const browser = await attachChrome();
  const context = browser.contexts()[0];
  context.on('response', (res) => {
    record(res).catch((e) => console.warn('[rec] failed:', (e as Error).message));
  });

  console.log('\n=================================================================');
  console.log(' In the browser window, on instamart.in:');
  console.log('  1. Sign in (phone + OTP). Set your delivery location if asked.');
  console.log('  2. Open your account -> Orders.');
  console.log('  3. Scroll the list so older orders load (a few pages).');
  console.log('  4. Open two or three individual orders to see their items.');
  console.log('  5. Close the browser window. The recorder then prints a summary.');
  console.log('=================================================================\n');

  // Chrome exiting (window closed) drops the CDP connection.
  await new Promise<void>((done) => browser.on('disconnected', () => done()));
  summarize();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
