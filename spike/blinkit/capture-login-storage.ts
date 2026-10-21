// What the vendor's own login writes into the browser.
//
//   npm run capture:login-storage
//
// Why this exists. Connecting an account logs in with our own `fetch` and then
// writes the token into the page. Every API call is then answered, and orders
// import perfectly - but the vendor's own checkout still offers "Login to
// Proceed", because the page's login JavaScript never ran and never wrote
// whatever else it writes (design Appendix A). The CVV box lives behind that
// gate, so Blinkit cannot be paid from the app until it is open.
//
// The first run of this answered half the question: no new localStorage keys
// appear at login, four existing ones are filled in, and `user` gains
// dateNow, id, phone and verified. Writing those four into an existing
// session by hand - real user id and all - left the gate shut. So this run
// asks the other half: which COOKIES a real login sets.
//
// HOW TO RUN IT
//   1. A Chrome window opens on blinkit.com with a fresh, signed-out profile.
//   2. Log in as you normally would: your phone, then the code you are sent.
//   3. The moment the site shows you as signed in, this prints the diff and
//      exits. Nothing else is touched and nothing is bought.
//
// It prints names, lengths and field names - never a value. The token, the
// code and every cookie's contents stay out of the output and out of the
// file it writes. The profile it uses is thrown away afterwards.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';

const ORIGIN = process.env.ORIGIN ?? 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const WAIT_MS = 15 * 60 * 1000;
const OUT_FILE = 'login-storage-diff.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'dm-login-'));

type Entry = { len: number; keys: string[] };
type Snap = Record<string, Entry>;
// A cookie described by everything except what it says.
type Cook = { len: number; domain: string; path: string; httpOnly: boolean; secure: boolean; session: boolean };

const READ = `(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k) || '';
    let keys = [];
    try {
      const j = JSON.parse(v);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        // Two levels, because a top-level key that was already there can
        // fill up without the diff noticing: user.profile went from empty to
        // something and the first run of this could not see it.
        for (const a of Object.keys(j).sort()) {
          const val = j[a];
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const inner = Object.keys(val).sort();
            keys.push(inner.length ? a + '{' + inner.join(',') + '}' : a + '{}');
          } else {
            keys.push(a);
          }
        }
      }
    } catch (e) {}
    out[k] = { len: v.length, keys: keys };
  }
  return out;
})()`;

async function cookiesOf(context: BrowserContext): Promise<Record<string, Cook>> {
  const out: Record<string, Cook> = {};
  for (const c of await context.cookies(ORIGIN)) {
    out[c.name] = {
      len: String(c.value ?? '').length,
      domain: c.domain,
      path: c.path,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      session: !c.expires || c.expires < 0,
    };
  }
  return out;
}

const child = spawn(
  CHROME_PATH,
  [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ORIGIN],
  { stdio: 'ignore' },
);

let browser: Browser | null = null;
try {
  await sleep(3000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await sleep(4000);

  const beforeLs = (await page.evaluate(READ)) as Snap;
  const beforeCk = await cookiesOf(context);
  console.log('signed out: %d storage keys, %d cookies', Object.keys(beforeLs).length, Object.keys(beforeCk).length);
  console.log('\nLog in in the window that opened. Waiting...\n');

  const until = Date.now() + WAIT_MS;
  let afterLs: Snap | null = null;
  while (Date.now() < until) {
    await sleep(2000);
    const now = (await page.evaluate(READ).catch(() => null)) as Snap | null;
    if (!now) continue;
    // Signed in when the page holds a token AND a filled-in user: the token
    // alone is no proof, the site holds one while signed out (Appendix A).
    const auth = now.auth?.keys ?? [];
    if (auth.includes('accessToken') && now.user && now.user.len > 40) {
      afterLs = now;
      break;
    }
  }

  if (!afterLs) {
    console.log('Gave up waiting. Nothing was recorded.');
  } else {
    const afterCk = await cookiesOf(context);

    console.log('=== STORAGE KEYS THAT APPEARED ===');
    const lsAppeared = Object.keys(afterLs).filter((k) => !(k in beforeLs)).sort();
    for (const k of lsAppeared) console.log(`  + ${k.padEnd(22)} ${afterLs[k].len}b  ${afterLs[k].keys.slice(0, 10).join(', ')}`);
    if (!lsAppeared.length) console.log('  (none)');

    console.log('\n=== STORAGE KEYS THAT CHANGED ===');
    const lsChanged = Object.keys(afterLs).filter(
      (k) => beforeLs[k] && (beforeLs[k].len !== afterLs![k].len || beforeLs[k].keys.join() !== afterLs![k].keys.join()),
    );
    for (const k of lsChanged.sort()) {
      const gained = afterLs[k].keys.filter((x) => !beforeLs[k].keys.includes(x));
      console.log(`  ~ ${k.padEnd(22)} ${beforeLs[k].len} -> ${afterLs[k].len}b${gained.length ? `  gained: ${gained.slice(0, 10).join(', ')}` : ''}`);
    }

    console.log('\n=== COOKIES THAT APPEARED ===  (this is the new question)');
    const ckAppeared = Object.keys(afterCk).filter((k) => !(k in beforeCk)).sort();
    for (const k of ckAppeared) {
      const c = afterCk[k];
      console.log(`  + ${k.padEnd(24)} ${String(c.len).padEnd(5)}b ${c.domain}${c.path} ${c.httpOnly ? 'httpOnly ' : ''}${c.secure ? 'secure ' : ''}${c.session ? 'session' : 'persistent'}`);
    }
    if (!ckAppeared.length) console.log('  (none)');

    console.log('\n=== COOKIES THAT CHANGED ===');
    const ckChanged = Object.keys(afterCk).filter((k) => beforeCk[k] && beforeCk[k].len !== afterCk[k].len).sort();
    for (const k of ckChanged) console.log(`  ~ ${k.padEnd(24)} ${beforeCk[k].len} -> ${afterCk[k].len}b`);
    if (!ckChanged.length) console.log('  (none)');

    // Written down too, because a terminal scrolls and asking again costs an
    // SMS. Names, lengths and field names only, exactly as printed.
    writeFileSync(
      OUT_FILE,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          storageAppeared: lsAppeared.map((k) => ({ key: k, len: afterLs![k].len, fields: afterLs![k].keys })),
          storageChanged: lsChanged.map((k) => ({
            key: k,
            from: beforeLs[k].len,
            to: afterLs![k].len,
            gained: afterLs![k].keys.filter((x) => !beforeLs[k].keys.includes(x)),
          })),
          cookiesAppeared: ckAppeared.map((k) => ({ name: k, ...afterCk[k] })),
          cookiesChanged: ckChanged.map((k) => ({ name: k, from: beforeCk[k].len, to: afterCk[k].len })),
        },
        null,
        1,
      ),
    );
    console.log(`\nNo values were printed. Also written to ${OUT_FILE}.`);
  }
} finally {
  await browser?.close().catch(() => undefined);
  child.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
