// Does a real page login survive being captured and restored?
//
//   npm run capture:login-survives
//
// This is the question that decides whether driving the vendor's login form
// is worth building at all. A person logging in on the page gets a browser
// whose checkout works - that much is known. What is NOT known is whether the
// thing that makes it work is something our connect flow captures.
//
// Connecting snapshots cookies and a handful of localStorage keys, and later
// replays them into a FRESH browser profile. If the page rebuilds its
// signed-in state from somewhere else - IndexedDB, sessionStorage, a service
// worker, anything tied to the profile - then a page login would restore
// exactly as broken as today's session, and the form work would be wasted.
//
// So: log in for real, snapshot what connect would snapshot, throw the
// browser away, restore into a clean one, and look at the checkout.
//
// HOW TO RUN IT
//   1. A Chrome window opens, signed out. Log in as you normally would.
//   2. It snapshots, closes that browser, and opens a fresh one with only the
//      snapshot restored.
//   3. It puts one item in the cart and reports whether the checkout is open
//      or still says "Login to Proceed". Then it empties the cart.
//
// Nothing is bought. No value of any input is read. Both profiles are thrown
// away afterwards.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const ORIGIN = process.env.ORIGIN ?? 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WAIT_MS = 15 * 60 * 1000;

// Exactly what server/src/constants.ts BLINKIT_SESSION_KEYS keeps.
const SESSION_KEYS = ['auth', 'authKey', 'authKeyITS', 'deviceId', 'user', 'merchant', 'location', 'addressesV2'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(port: number, profileDir: string): Promise<{ child: ChildProcess; browser: Browser; page: Page }> {
  const child = spawn(
    CHROME_PATH,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', ORIGIN],
    { stdio: 'ignore' },
  );
  await sleep(3500);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await sleep(3500);
  return { child, browser, page };
}

// One item in, through the vendor's own button, then look at the checkout.
async function gateOpen(page: Page): Promise<{ open: boolean; control: string }> {
  await page.goto(`${ORIGIN}/s/?q=${encodeURIComponent('amul taaza milk')}`, { waitUntil: 'load', timeout: 60_000 });
  await sleep(4000);
  const add = page.getByRole('button', { name: /^add$/i });
  if (await add.count()) {
    await add.first().click({ timeout: 10_000 }).catch(() => undefined);
    await sleep(3000);
  }
  await page.goto(`${ORIGIN}/cart`, { waitUntil: 'load', timeout: 60_000 });
  await sleep(5000);
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const at = txt.search(/login to proceed|proceed to pay|pay now|place order/i);
  return { open: !/login to proceed/i.test(txt), control: at >= 0 ? txt.slice(Math.max(0, at - 25), at + 50) : '(no control found)' };
}

const profileA = mkdtempSync(join(tmpdir(), 'dm-live-'));
const profileB = mkdtempSync(join(tmpdir(), 'dm-restored-'));
let a: Awaited<ReturnType<typeof open>> | null = null;
let b: Awaited<ReturnType<typeof open>> | null = null;

try {
  // ---- 1. a real login, in a real browser -------------------------------
  a = await open(9338, profileA);
  console.log('Log in in the window that opened. Waiting...\n');
  const until = Date.now() + WAIT_MS;
  let signedIn = false;
  while (Date.now() < until) {
    await sleep(2000);
    signedIn = (await a.page
      .evaluate(`(() => { try { return JSON.parse(localStorage.getItem('user') || '{}').verified === true; } catch (e) { return false; } })()`)
      .catch(() => false)) as boolean;
    if (signedIn) break;
  }
  if (!signedIn) throw new Error('never saw a signed-in page; nothing to test');
  console.log('Signed in.');

  // Is the checkout open in the browser that actually logged in? If this is
  // shut, the whole premise is wrong and nothing below matters.
  const live = await gateOpen(a.page);
  console.log(`  freshly logged in : gate ${live.open ? 'OPEN' : 'SHUT'} | ${live.control}`);

  // ---- 2. snapshot exactly what connecting keeps ------------------------
  const storage = (await a.page.evaluate(
    `(() => { const out = {}; for (const k of ${JSON.stringify(SESSION_KEYS)}) { const v = localStorage.getItem(k); if (v !== null) out[k] = v; } return out; })()`,
  )) as Record<string, string>;
  const cookies = await a.browser.contexts()[0].cookies(ORIGIN);
  console.log(`  captured          : ${Object.keys(storage).length} storage keys, ${cookies.length} cookies`);

  // Anything else the page might be leaning on, named only.
  const others = (await a.page.evaluate(`(async () => {
    const out = { sessionStorage: [], indexedDB: [], serviceWorkers: 0 };
    for (let i = 0; i < sessionStorage.length; i++) out.sessionStorage.push(sessionStorage.key(i));
    try { if (indexedDB.databases) { for (const d of await indexedDB.databases()) out.indexedDB.push(d.name); } } catch (e) {}
    try { if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); out.serviceWorkers = rs.length; } } catch (e) {}
    return out;
  })()`)) as { sessionStorage: string[]; indexedDB: string[]; serviceWorkers: number };
  console.log(`  also present      : sessionStorage [${others.sessionStorage.join(', ') || 'none'}] indexedDB [${others.indexedDB.join(', ') || 'none'}] serviceWorkers ${others.serviceWorkers}`);

  await a.browser.close().catch(() => undefined);
  a.child.kill();
  a = null;
  await sleep(1500);

  // ---- 3. restore into a clean browser, the way the worker does ---------
  b = await open(9339, profileB);
  await b.browser.contexts()[0].addCookies(
    cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure })),
  );
  await b.page.evaluate(
    `(() => { const s = ${JSON.stringify(storage)}; for (const k of Object.keys(s)) localStorage.setItem(k, s[k]); })()`,
  );
  await b.page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
  await sleep(4000);
  console.log(`  restored user     : ${await b.page.evaluate(`localStorage.getItem('user')`)}`);

  const restored = await gateOpen(b.page);
  console.log(`  restored session  : gate ${restored.open ? 'OPEN' : 'SHUT'} | ${restored.control}`);

  console.log(
    restored.open
      ? '\nVERDICT: a page login survives capture and restore. Driving the login form is worth building.'
      : '\nVERDICT: it does NOT survive. Driving the form would change nothing, and the session would have to keep its own browser profile instead.',
  );

  // Put the account back as it was.
  await b.page.evaluate(`(async () => {
    try {
      await fetch('/v5/carts', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [], promo_codes: [''] }) });
    } catch (e) {}
  })()`);
  console.log('cart emptied.');
} finally {
  await a?.browser.close().catch(() => undefined);
  a?.child.kill();
  await b?.browser.close().catch(() => undefined);
  b?.child.kill();
  await sleep(500);
  rmSync(profileA, { recursive: true, force: true });
  rmSync(profileB, { recursive: true, force: true });
}
