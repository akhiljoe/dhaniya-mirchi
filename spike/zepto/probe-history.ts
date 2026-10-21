// Can we read Zepto's order history ourselves, or only by driving the page?
//
// Every bff-gateway call the site makes carries a `request-signature` header
// (64 hex, different on every call) and a hashed `x-timezone`. Instamart's
// order reads worked from our own in-page fetch while its payment call did
// not, so the answer has to be measured, not assumed. This tries, from inside
// the signed-in zepto.com page, from least to most help:
//
//   A  a bare fetch, cookies only
//   B  the site's own plain headers (device, session, store, xsrf), no signature
//   C  B plus a signature the site made for an EARLIER call (is it checked?)
//   E  only the three headers found to matter (2026-09-24): app_version,
//      appversion, auth_from_cookie. Without an app version the gateway
//      fails the call at CORS; without auth_from_cookie it answers 401.
//   D  the page's own button: click Load More and overhear the answer
//
// and the same A, B, C, E for one order's detail (POST ORDER_DETAILS).
//
//   npx tsx probe-history.ts [runDir]
//
// runDir is a recording that holds a signed order-list request; the newest is
// used by default. Only statuses, order counts and the first bytes of an
// error are printed: never a body, never a header's value.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9336;
const USER_DATA_DIR = './.chromedata';
const ORIGIN = 'https://www.zepto.com';
const API = 'https://bff-gateway.zepto.com';
const LIST_PATH = '/api/v2/order/?page_number=2';
const DETAIL_PATH = '/pfs-postorder/api/v1/get-page/ORDER_DETAILS';
// Headers the browser sets itself, or that belong to one call only.
const NOT_COPIED = /^(:|accept-encoding|content-length|cookie|origin|referer|priority|sec-|user-agent|host)/i;
const MINIMAL = /^(app_version|appversion|auth_from_cookie)$/i;
const SIGNED = /^(request-signature|x-timezone)$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Recorded {
  kind: string;
  n: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}

function newestRun(): string {
  const runs = readdirSync('runs').sort();
  return join('runs', runs[runs.length - 1]);
}

function recordedRequest(runDir: string, test: (e: Recorded) => boolean): Recorded {
  for (const line of readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line) as Recorded;
    if (e.kind === 'request' && test(e)) return e;
  }
  throw new Error(`no matching request recorded in ${runDir}`);
}

function headersFrom(req: Recorded, withSignature: boolean, minimal = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (minimal && !MINIMAL.test(k)) continue;
    if (NOT_COPIED.test(k)) continue;
    if (SIGNED.test(k) && !withSignature) continue;
    out[k] = v;
  }
  return out;
}

async function attach() {
  const up = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(
    () => true,
    () => false,
  );
  if (!up) {
    const chrome = spawn(
      CHROME_PATH,
      [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${resolve(USER_DATA_DIR)}`, '--no-first-run', '--no-default-browser-check', `${ORIGIN}/`],
      { stdio: 'ignore', detached: true },
    );
    chrome.unref();
  }
  for (let i = 0; i < 40; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch {
      await sleep(500);
    }
  }
  throw new Error('Chrome did not open its debugging port');
}

// Passed as a string: tsx injects a `__name` helper into compiled closures
// that does not exist in the page.
async function pageFetch(page: Page, url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const a = JSON.stringify({ url, ...init });
  return page.evaluate(`(async () => {
    const a = ${a};
    try {
      const r = await fetch(a.url, { method: a.method, credentials: 'include', headers: a.headers, body: a.body });
      return { status: r.status, body: await r.text() };
    } catch (e) {
      return { status: -1, body: String(e) };
    }
  })()`) as Promise<{ status: number; body: string }>;
}

function verdictList(r: { status: number; body: string }): string {
  try {
    const j = JSON.parse(r.body);
    if (Array.isArray(j.orders)) return `${r.status}  ${j.orders.length} orders  <- WORKS`;
  } catch {
    /* not json */
  }
  return `${r.status}  refused: ${r.body.replace(/\s+/g, ' ').slice(0, 140)}`;
}

function verdictDetail(r: { status: number; body: string }): string {
  if (r.status === 200 && r.body.includes('formattedPacksize')) return `${r.status}  pack sizes present  <- WORKS`;
  return `${r.status}  refused: ${r.body.replace(/\s+/g, ' ').slice(0, 140)}`;
}

async function main() {
  const runDir = process.argv[2] ?? newestRun();
  console.log(`headers taken from ${runDir}\n`);
  const listReq = recordedRequest(runDir, (e) => e.url.includes('/api/v2/order/?page_number='));
  const detailReq = recordedRequest(runDir, (e) => e.url.includes('ORDER_DETAILS') && !!e.postData && !e.postData.includes('page_number'));

  const browser = await attach();
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(4000); // WAF token and app bootstrap

  console.log('order list, page 2');
  console.log(`  A bare             ${verdictList(await pageFetch(page, API + LIST_PATH, { method: 'GET', headers: {} }))}`);
  console.log(`  B site headers     ${verdictList(await pageFetch(page, API + LIST_PATH, { method: 'GET', headers: headersFrom(listReq, false) }))}`);
  console.log(`  C + old signature  ${verdictList(await pageFetch(page, API + LIST_PATH, { method: 'GET', headers: headersFrom(listReq, true) }))}`);
  console.log(`  E three headers    ${verdictList(await pageFetch(page, API + LIST_PATH, { method: 'GET', headers: headersFrom(listReq, false, true) }))}`);

  const detailInit = (sig: boolean) => ({ method: 'POST', headers: { ...headersFrom(detailReq, sig), 'content-type': 'application/json' }, body: detailReq.postData });
  console.log('\norder detail');
  console.log(`  A bare             ${verdictDetail(await pageFetch(page, API + DETAIL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: detailReq.postData }))}`);
  console.log(`  B site headers     ${verdictDetail(await pageFetch(page, API + DETAIL_PATH, detailInit(false)))}`);
  console.log(`  C + old signature  ${verdictDetail(await pageFetch(page, API + DETAIL_PATH, detailInit(true)))}`);
  console.log(
    `  E three headers    ${verdictDetail(await pageFetch(page, API + DETAIL_PATH, { method: 'POST', headers: { ...headersFrom(detailReq, false, true), 'content-type': 'application/json' }, body: detailReq.postData }))}`,
  );

  console.log('\nD the page itself: open the orders list, press Load More once');
  const heard: number[] = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/api/v2/order/?page_number=')) return;
    try {
      const j = JSON.parse(await res.text());
      heard.push(Array.isArray(j.orders) ? j.orders.length : -1);
    } catch {
      heard.push(-1);
    }
  });
  await page.goto(`${ORIGIN}/account`, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(4000);
  const more = page.getByRole('button', { name: /load more/i });
  if (await more.count()) {
    await more.first().click();
    await page.waitForTimeout(3000);
  }
  console.log(`  pages overheard: ${heard.length}, orders per page: ${heard.join(', ') || 'none'}`);

  await page.close();
  await browser.close(); // detaches; the Chrome window stays signed in
}

main().catch((e) => {
  console.error('[fail]', e instanceof Error ? e.message : e);
  process.exit(1);
});
