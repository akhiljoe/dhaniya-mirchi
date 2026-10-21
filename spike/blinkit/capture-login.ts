// Blinkit login recon — the one thing the Phase 0 spike never recorded.
//
// capture.ts logged in by hand and only grabbed `order_history`, so the
// send-OTP / verify-OTP calls were never seen. The worker cannot drive a login
// it has never watched (design §7.10: our page takes the phone and the code,
// the worker calls the vendor's own endpoints from inside the page).
//
// This script watches. It opens a browser on a FRESH profile (so Blinkit is
// signed out), records every request the page makes to blinkit.com while YOU
// log in with your phone + OTP, and writes login-recon.json: the exact calls,
// their headers, their bodies and their answers — plus what the page holds
// afterwards (localStorage, cookies) and the headers it attaches to
// order_history once logged in.
//
//   npm run capture:login
//
// The recipe is the worker's, not Playwright's: the installed Chrome is
// spawned as a plain process and only attached to over CDP (design §7.5 —
// Playwright-launched browsers are what the vendors' edges detect). Headful
// here on purpose: you are the one typing.
//
// login-recon.json holds YOUR phone number, the OTP you typed and a live
// session token. It is gitignored. Delete it once the adapter is written.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const ORIGIN = 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334); // 9333 is the Instamart spike's
// A profile of its own, never the everyday one and never the spike's logged-in
// .userdata: the whole point is to start signed out and watch the login.
const USER_DATA_DIR = './.logindata';
const OUT_FILE = 'login-recon.json';
const LOGIN_TIMEOUT_MS = 8 * 60 * 1000; // you have to reach for your phone
const BODY_LIMIT = 8000; // enough to read a shape, not a whole widget tree

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RecordedCall {
  at: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  postData: string | null;
  status: number | null;
  contentType: string | null;
  body: string | null; // truncated
}

// Calls worth reading first: anything whose path or body smells of the login.
const AUTH_HINT = /otp|login|log-?in|auth|verify|signin|sign-?up|token|session|account|user/i;

function isBlinkit(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('blinkit.com');
  } catch {
    return false;
  }
}

// The console is a shared screen and a scrollback. Long digit runs (phone, OTP)
// and token-shaped values are masked there; the file keeps them verbatim
// because the adapter is written against the real shapes.
function mask(s: string): string {
  return s
    .replace(/\d{4,}/g, (d) => `${d.slice(0, 2)}${'*'.repeat(Math.max(0, d.length - 2))}`)
    .replace(/([A-Za-z0-9_-]{24,})/g, (t) => `${t.slice(0, 6)}…(${t.length} chars)`);
}

function keysOf(text: string | null): string[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object') return Object.keys(v as Record<string, unknown>);
  } catch {
    // not JSON — form-encoded or a widget tree
  }
  return [];
}

function launchChrome(startUrl: string): void {
  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${resolve(USER_DATA_DIR)}`,
      '--no-first-run',
      '--no-default-browser-check',
      startUrl,
    ],
    { stdio: 'ignore', detached: true },
  );
  chrome.on('error', (e) => {
    console.error(`[fail] could not start Chrome at ${CHROME_PATH}: ${e.message}`);
    console.error('       Set CHROME_PATH to the installed Chrome if it lives elsewhere.');
    process.exit(1);
  });
  chrome.unref();
}

async function attachChrome(startUrl: string): Promise<Browser> {
  const up = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(
    () => true,
    () => false,
  );
  if (!up) launchChrome(startUrl);
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (e) {
      last = e;
      await sleep(500); // Chrome takes a moment to open its debugging port
    }
  }
  throw last;
}

function watch(page: Page, calls: RecordedCall[]): void {
  page.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
    if (!isBlinkit(req.url())) return;
    let body: string | null = null;
    let contentType: string | null = null;
    try {
      contentType = (await res.headerValue('content-type')) ?? null;
      // A document response is the app shell: megabytes of HTML with nothing
      // to learn. Only structured answers are kept.
      if (contentType && /json|text\/plain/i.test(contentType)) body = (await res.text()).slice(0, BODY_LIMIT);
    } catch {
      body = null; // a redirect or an aborted response has no readable body
    }
    let requestHeaders: Record<string, string> = {};
    try {
      requestHeaders = await req.allHeaders();
    } catch {
      requestHeaders = req.headers();
    }
    calls.push({
      at: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      resourceType: type,
      requestHeaders,
      postData: req.postData(),
      status: res.status(),
      contentType,
      body,
    });
  });
}

// The login state lands in localStorage's `user` (capture.ts waits on the same
// thing). Polled from Node rather than page.waitForFunction so the wait
// survives the page navigating, which the login does.
async function waitForLogin(page: Page, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const inside = await page.evaluate(`(() => {
        try {
          const u = JSON.parse(localStorage.getItem('user') || 'null');
          return !!(u && u.id);
        } catch { return false; }
      })()`);
      if (inside === true) return true;
    } catch {
      // mid-navigation: the execution context is gone for a moment
    }
    await sleep(1000);
  }
  return false;
}

async function main() {
  const calls: RecordedCall[] = [];
  const browser = await attachChrome(`${ORIGIN}/`);
  const context = browser.contexts()[0];

  // Watch every tab, including ones the login opens.
  for (const p of context.pages()) watch(p, calls);
  context.on('page', (p) => watch(p, calls));

  let page = context.pages().find((p) => isBlinkit(p.url())) ?? context.pages()[0] ?? (await context.newPage());
  if (!isBlinkit(page.url())) await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });

  console.log('\n=================================================================');
  console.log(' A Chrome window is open on blinkit.com, signed out.');
  console.log('');
  console.log(' 1. Enter your delivery pincode if it asks.');
  console.log(' 2. Log in: phone number, then the OTP from your phone.');
  console.log('');
  console.log(' Every call the page makes is being recorded. Nothing is typed');
  console.log(' for you. The script stops on its own once you are logged in.');
  console.log('=================================================================\n');

  const loggedIn = await waitForLogin(page, Date.now() + LOGIN_TIMEOUT_MS);
  if (!loggedIn) {
    console.error(`\n[fail] Not logged in within ${LOGIN_TIMEOUT_MS / 60000} minutes. Nothing written.`);
    await browser.close();
    process.exit(1);
  }
  console.log('[ok] logged in.');

  // Whatever the page attaches to its own authenticated calls is what the
  // worker must replay. Load Orders fresh to make it send order_history.
  page = context.pages().find((p) => isBlinkit(p.url())) ?? page;
  await page.goto(`${ORIGIN}/account/orders`, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(5000);

  const storage = (await page.evaluate(`(() => {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out[k] = localStorage.getItem(k);
      }
    } catch (e) { /* storage blocked */ }
    return out;
  })()`)) as Record<string, string>;

  const cookies = await context.cookies(ORIGIN);
  const orderHistory = calls.filter((c) => c.url.includes('/v1/layout/order_history')).pop() ?? null;

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        origin: ORIGIN,
        calls,
        afterLogin: {
          localStorage: storage,
          cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure })),
          orderHistoryRequestHeaders: orderHistory?.requestHeaders ?? null,
          orderHistoryStatus: orderHistory?.status ?? null,
        },
      },
      null,
      2,
    ),
  );

  // ---- What was learned, masked for the screen -------------------------------
  const candidates = calls.filter((c) => c.resourceType !== 'document' && (AUTH_HINT.test(c.url) || AUTH_HINT.test(c.postData ?? '')));
  console.log(`\n[ok] ${calls.length} blinkit.com calls recorded → ${OUT_FILE}`);
  console.log(`\n--- login-shaped calls (${candidates.length}) ---------------------------------`);
  for (const c of candidates) {
    console.log(`\n${c.method} ${mask(c.url)}  → ${c.status}`);
    const reqKeys = keysOf(c.postData);
    if (c.postData) console.log(`  request  ${reqKeys.length ? `keys: ${reqKeys.join(', ')}` : `body: ${mask(c.postData).slice(0, 200)}`}`);
    const resKeys = keysOf(c.body);
    if (resKeys.length) console.log(`  response keys: ${resKeys.join(', ')}`);
    const custom = Object.keys(c.requestHeaders).filter((h) => !h.startsWith(':') && /auth|device|token|key|app|version|lat|lon/i.test(h));
    if (custom.length) console.log(`  headers: ${custom.join(', ')}`);
  }

  console.log(`\n--- after login ---------------------------------------------------`);
  console.log(`  localStorage keys: ${Object.keys(storage).join(', ') || '(none)'}`);
  console.log(`  cookies: ${cookies.map((c) => c.name).join(', ') || '(none)'}`);
  console.log(`  order_history: ${orderHistory ? `HTTP ${orderHistory.status}, headers: ${Object.keys(orderHistory.requestHeaders).filter((h) => !h.startsWith(':')).join(', ')}` : 'not seen'}`);
  console.log(`\n${OUT_FILE} holds your phone, the code you typed and a live token. Gitignored. Delete it when the adapter is done.`);

  await browser.close();
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
