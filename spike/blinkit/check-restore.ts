// Does the captured login survive a restore? Asked properly this time.
//
//   npm run check:restore
//
// Runs entirely against login-all.json, so it costs nobody a code.
//
// The first attempt at this answered "open" for all three browsers, including
// one that had just logged in - because it looked for the words "Login to
// Proceed" and, finding no checkout control at all, read the absence as an
// open gate. The cart was simply empty: the ADD never landed. So this one
// PROVES the cart has something in it before it believes anything about the
// page, and says "cannot tell" when it does not, rather than "open".
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ORIGIN = process.env.ORIGIN ?? 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const IN_FILE = 'login-all.json';
const SESSION_KEYS = ['auth', 'authKey', 'authKeyITS', 'deviceId', 'user', 'merchant', 'location', 'addressesV2'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Saved {
  storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
  cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }[];
}
const saved = JSON.parse(readFileSync(IN_FILE, 'utf8')) as Saved;

async function open(port: number, dir: string): Promise<{ child: ChildProcess; browser: Browser; context: BrowserContext; page: Page }> {
  const child = spawn(CHROME_PATH, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  await sleep(3500);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  return { child, browser, context, page };
}

// Put one item in through the vendor's own cart call, and CHECK it is there.
// Using the call rather than the button because the button is what failed
// silently last time, and what is being tested here is the page's idea of who
// is signed in, not its idea of what a click means.
async function fillOne(page: Page): Promise<number> {
  const r = (await page.evaluate(`(async () => {
    const s = await fetch('/v1/layout/search?q=amul%20taaza%20milk', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'amul taaza milk' })
    }).then((x) => x.text()).catch(() => '');
    const m = s.match(/"product_id":(\\d+)/);
    if (!m) return { lines: -1 };
    const c = await fetch('/v5/carts', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ product_id: Number(m[1]), quantity: 1 }], promo_codes: [''] })
    }).then((x) => x.json()).catch(() => null);
    const items = c && c.cart_data && c.cart_data.items;
    return { lines: Array.isArray(items) ? items.length : -1 };
  })()`)) as { lines: number };
  return r.lines;
}

async function emptyCart(page: Page): Promise<void> {
  await page
    .evaluate(`fetch('/v5/carts', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [], promo_codes: [''] }) }).then(() => 1).catch(() => 0)`)
    .catch(() => undefined);
}

async function verdict(label: string, keys: string[] | null, withSession: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dm-chk-'));
  const b = await open(9350 + Math.floor(Math.random() * 40), dir);
  try {
    await b.context.addCookies(saved.cookies.map((c) => ({ ...c })));
    await b.page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    const ls = keys
      ? Object.fromEntries(Object.entries(saved.storage.localStorage).filter(([k]) => keys.includes(k)))
      : saved.storage.localStorage;
    await b.page.evaluate(`(() => { const s = ${JSON.stringify(ls)}; for (const k of Object.keys(s)) localStorage.setItem(k, s[k]); })()`);
    if (withSession) {
      await b.page.evaluate(`(() => { const t = ${JSON.stringify(saved.storage.sessionStorage)}; for (const k of Object.keys(t)) sessionStorage.setItem(k, t[k]); })()`);
    }
    await b.page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await sleep(4000);

    const user = (await b.page.evaluate(`localStorage.getItem('user')`)) as string | null;
    const lines = await fillOne(b.page);
    if (lines <= 0) {
      console.log(`  ${label.padEnd(30)} CANNOT TELL - the cart would not fill (lines=${lines})`);
      return;
    }
    await b.page.goto(`${ORIGIN}/cart`, { waitUntil: 'load', timeout: 60_000 });
    await sleep(5000);
    const txt = (await b.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const shut = /login to proceed/i.test(txt);
    const proceed = /proceed to pay|pay now|place order/i.test(txt);
    const shows = /amul|shipment of/i.test(txt);
    const state = shut ? 'SHUT' : proceed ? 'OPEN' : 'CANNOT TELL';
    console.log(`  ${label.padEnd(30)} ${state.padEnd(11)} | cart rendered: ${shows} | user: ${String(user).slice(0, 46)}`);
    await emptyCart(b.page);
  } finally {
    await b.browser.close().catch(() => undefined);
    b.child.kill();
    await sleep(500);
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`from ${IN_FILE}: ${Object.keys(saved.storage.localStorage).length} storage keys, ${saved.cookies.length} cookies\n`);
await verdict('the 8 keys connect keeps:', SESSION_KEYS, false);
await verdict('everything:', null, true);
console.log('\nSHUT means a restore loses the login. OPEN means it survives.');
