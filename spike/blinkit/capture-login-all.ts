// One login. Everything recorded. No second login, ever.
//
//   npm run capture:login-all
//
// This replaces the three narrower capture scripts. It answers, from a single
// sign-in, every question still open about why a restored Blinkit session can
// read orders but cannot reach the vendor's own checkout (design Appendix A):
//
//   1. WHAT THE LOGIN FORM LOOKS LIKE, step by step, so the connect adapter
//      can drive it. Blinkit renders controls as divs, so nothing can be
//      found by role and it cannot be guessed.
//   2. WHAT THE LOGIN WRITES: every localStorage key, sessionStorage key,
//      cookie, IndexedDB database and service worker, before and after.
//   3. WHETHER A CAPTURED SESSION SURVIVES A RESTORE - which is the premise
//      the whole plan rests on. It restores into a clean browser profile
//      twice: once with only the eight keys connect keeps today, and once
//      with everything. If "everything" works and "eight keys" does not, the
//      fix is simply to capture more, and no form work is needed at all.
//
// It writes the whole snapshot to login-all.json (gitignored), so every later
// experiment runs against that file instead of asking for another code.
//
// THE FILE HOLDS A LIVE SESSION. That is the point - it is what makes the
// repeats free - and it is why it is gitignored, kept local, and worth
// deleting once Blinkit can pay. Nothing typed into an input is ever read, so
// the phone number and the code are not in it.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ORIGIN = process.env.ORIGIN ?? 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WAIT_MS = 15 * 60 * 1000;
const OUT_FILE = 'login-all.json';

// What server/src/constants.ts BLINKIT_SESSION_KEYS keeps today.
const SESSION_KEYS = ['auth', 'authKey', 'authKeyITS', 'deviceId', 'user', 'merchant', 'location', 'addressesV2'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EVERYTHING = `(async () => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
  const ss = {};
  for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); }
  const idb = [];
  try { if (indexedDB.databases) { for (const d of await indexedDB.databases()) idb.push(d.name); } } catch (e) {}
  let sw = 0;
  try { if (navigator.serviceWorker) sw = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) {}
  return { localStorage: ls, sessionStorage: ss, indexedDB: idb, serviceWorkers: sw };
})()`;

// Never reads an input's value.
const FORM = `(() => {
  const inputs = [];
  for (const el of document.querySelectorAll('input')) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    inputs.push({ type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.id || null,
      placeholder: el.getAttribute('placeholder'), maxLength: el.maxLength,
      inputMode: el.getAttribute('inputmode'), cls: String(el.className || '').slice(0, 70) });
  }
  const clickable = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a, div, span')) {
    if (el.children.length > 1) continue;
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 40) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 8 && r.height > 8)) continue;
    const key = el.tagName + '|' + t;
    if (seen.has(key)) continue;
    seen.add(key);
    clickable.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 70), text: t });
    if (clickable.length >= 30) break;
  }
  const h = document.querySelector('h1, h2, h3');
  return { inputs, clickable, heading: h ? (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '' };
})()`;

type Snap = { localStorage: Record<string, string>; sessionStorage: Record<string, string>; indexedDB: string[]; serviceWorkers: number };

async function open(port: number, dir: string): Promise<{ child: ChildProcess; browser: Browser; context: BrowserContext; page: Page }> {
  const child = spawn(CHROME_PATH, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ORIGIN], { stdio: 'ignore' });
  await sleep(3500);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await sleep(3500);
  return { child, browser, context, page };
}

// One item in through the vendor's own button, then read the checkout.
async function gate(page: Page, label: string): Promise<boolean> {
  await page.goto(`${ORIGIN}/s/?q=${encodeURIComponent('amul taaza milk')}`, { waitUntil: 'load', timeout: 60_000 }).catch(() => undefined);
  await sleep(4000);
  const add = page.getByRole('button', { name: /^add$/i });
  if (await add.count()) {
    await add.first().click({ timeout: 10_000 }).catch(() => undefined);
    await sleep(3000);
  }
  await page.goto(`${ORIGIN}/cart`, { waitUntil: 'load', timeout: 60_000 }).catch(() => undefined);
  await sleep(5000);
  const txt = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const shut = /login to proceed/i.test(txt);
  const at = txt.search(/login to proceed|proceed to pay|pay now|place order/i);
  console.log(`  ${label.padEnd(30)} gate ${shut ? 'SHUT' : 'OPEN'} | ${at >= 0 ? txt.slice(Math.max(0, at - 20), at + 45) : '(no control)'}`);
  return !shut;
}

async function emptyCart(page: Page): Promise<void> {
  await page
    .evaluate(`fetch('/v5/carts', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [], promo_codes: [''] }) }).then(() => 1).catch(() => 0)`)
    .catch(() => undefined);
}

const dirA = mkdtempSync(join(tmpdir(), 'dm-live-'));
const dirB = mkdtempSync(join(tmpdir(), 'dm-eight-'));
const dirC = mkdtempSync(join(tmpdir(), 'dm-all-'));
let a: Awaited<ReturnType<typeof open>> | null = null;
let b: Awaited<ReturnType<typeof open>> | null = null;
let c: Awaited<ReturnType<typeof open>> | null = null;
const steps: unknown[] = [];

try {
  // ---- 1. the login, watched --------------------------------------------
  a = await open(9340, dirA);
  const before = (await a.page.evaluate(EVERYTHING)) as Snap;
  const cookiesBefore = await a.context.cookies(ORIGIN);
  console.log(`signed out: ${Object.keys(before.localStorage).length} storage, ${cookiesBefore.length} cookies, idb [${before.indexedDB.join(', ') || 'none'}], sw ${before.serviceWorkers}`);
  console.log('\nLog in in the window that opened. This is the only time you will be asked.\n');

  const until = Date.now() + WAIT_MS;
  let last = '';
  let signedIn = false;
  while (Date.now() < until) {
    await sleep(1000);
    const shot = (await a.page.evaluate(FORM).catch(() => null)) as { inputs: Record<string, unknown>[]; clickable: { tag: string; cls: string; text: string }[]; heading: string } | null;
    if (shot) {
      const sig = JSON.stringify([shot.inputs.map((i) => `${i.type}:${i.maxLength}:${i.placeholder}`), shot.heading]);
      if (sig !== last) {
        last = sig;
        steps.push(shot);
        console.log(`--- screen ${steps.length}${shot.heading ? `: ${shot.heading}` : ''}`);
        for (const i of shot.inputs) console.log(`    input  type=${i.type} maxLength=${i.maxLength} inputMode=${i.inputMode} placeholder=${JSON.stringify(i.placeholder)} cls=${String(i.cls).slice(0, 40)}`);
        for (const k of shot.clickable.filter((x) => /log\s*in|continue|verify|submit|resend|otp|phone|sign/i.test(x.text)).slice(0, 6)) {
          console.log(`    click  ${k.tag} "${k.text}" cls=${k.cls.slice(0, 40)}`);
        }
      }
    }
    signedIn = (await a.page
      .evaluate(`(() => { try { return JSON.parse(localStorage.getItem('user') || '{}').verified === true; } catch (e) { return false; } })()`)
      .catch(() => false)) as boolean;
    if (signedIn) break;
  }
  if (!signedIn) throw new Error('never saw a signed-in page');
  console.log('\nSigned in.\n');

  // ---- 2. everything it wrote -------------------------------------------
  const after = (await a.page.evaluate(EVERYTHING)) as Snap;
  const cookiesAfter = await a.context.cookies(ORIGIN);
  console.log('what changed:');
  for (const k of Object.keys(after.localStorage)) {
    const wasLen = (before.localStorage[k] ?? '').length;
    const nowLen = after.localStorage[k].length;
    if (!(k in before.localStorage)) console.log(`  + localStorage ${k} (${nowLen}b)`);
    else if (wasLen !== nowLen) console.log(`  ~ localStorage ${k} ${wasLen} -> ${nowLen}b`);
  }
  for (const ck of cookiesAfter) {
    const was = cookiesBefore.find((x) => x.name === ck.name);
    if (!was) console.log(`  + cookie ${ck.name} (${String(ck.value).length}b) ${ck.httpOnly ? 'httpOnly ' : ''}${ck.secure ? 'secure' : ''}`);
  }
  console.log(`  sessionStorage keys: [${Object.keys(after.sessionStorage).join(', ') || 'none'}]`);
  console.log(`  indexedDB: [${after.indexedDB.join(', ') || 'none'}]  serviceWorkers: ${after.serviceWorkers}`);

  writeFileSync(
    OUT_FILE,
    JSON.stringify({ capturedAt: new Date().toISOString(), origin: ORIGIN, loginScreens: steps, storage: after, cookies: cookiesAfter }, null, 1),
  );
  console.log(`\nSaved to ${OUT_FILE}. Every later experiment reads that file - you will not be asked again.\n`);

  console.log('does the checkout work, and does it survive a restore?');
  await gate(a.page, 'the browser that logged in:');
  await emptyCart(a.page);
  await a.browser.close().catch(() => undefined);
  a.child.kill();
  a = null;
  await sleep(1500);

  // ---- 3. restored with only the eight keys connect keeps ---------------
  b = await open(9341, dirB);
  await b.context.addCookies(cookiesAfter.map((x) => ({ name: x.name, value: x.value, domain: x.domain, path: x.path, expires: x.expires, httpOnly: x.httpOnly, secure: x.secure })));
  const eight: Record<string, string> = {};
  for (const k of SESSION_KEYS) if (after.localStorage[k] !== undefined) eight[k] = after.localStorage[k];
  await b.page.evaluate(`(() => { const s = ${JSON.stringify(eight)}; for (const k of Object.keys(s)) localStorage.setItem(k, s[k]); })()`);
  await b.page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
  await sleep(4000);
  const eightWorks = await gate(b.page, 'restored, the 8 keys today:');
  await emptyCart(b.page);
  await b.browser.close().catch(() => undefined);
  b.child.kill();
  b = null;
  await sleep(1500);

  // ---- 4. restored with everything --------------------------------------
  c = await open(9342, dirC);
  await c.context.addCookies(cookiesAfter.map((x) => ({ name: x.name, value: x.value, domain: x.domain, path: x.path, expires: x.expires, httpOnly: x.httpOnly, secure: x.secure })));
  await c.page.evaluate(
    `(() => { const s = ${JSON.stringify(after.localStorage)}; for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
              const t = ${JSON.stringify(after.sessionStorage)}; for (const k of Object.keys(t)) sessionStorage.setItem(k, t[k]); })()`,
  );
  await c.page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
  await sleep(4000);
  const allWorks = await gate(c.page, 'restored, everything:');
  await emptyCart(c.page);

  console.log('\nVERDICT');
  if (allWorks && !eightWorks) console.log('  Capturing more is the whole fix. No login form work is needed: keep every key, not eight.');
  else if (allWorks && eightWorks) console.log('  A restore works either way, so the live session is stale rather than wrong. Reconnecting is the fix.');
  else console.log('  A restore does not carry the login however much is copied. The session must keep its own browser profile, and driving the login form alone will not help.');
} finally {
  for (const x of [a, b, c]) {
    await x?.browser.close().catch(() => undefined);
    x?.child.kill();
  }
  await sleep(500);
  for (const d of [dirA, dirB, dirC]) rmSync(d, { recursive: true, force: true });
}
