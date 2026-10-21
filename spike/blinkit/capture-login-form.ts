// The shapes of the vendor's own login form, so the connect adapter can drive
// it instead of calling the login endpoint directly.
//
//   npm run capture:login-form
//
// Why a real login is needed to learn this. Blinkit renders its controls as
// plain divs, not buttons, so nothing can be found by role, and three blind
// attempts at the signed-out page found no login control at all. Watching a
// person do it is the reliable way.
//
// Why the adapter has to drive the form. Connecting logs in with our own
// `fetch`, exactly as the Instamart adapter does. On Instamart that is enough,
// because its login lives in cookies and cookies restore cleanly. Blinkit's
// lives in client state that the page rebuilds at boot, and a session that
// never logged in through the page never gets it - so the vendor's own
// checkout offers "Login to Proceed" while every API call keeps working
// (design Appendix A).
//
// HOW TO RUN IT
//   1. A Chrome window opens on blinkit.com, signed out.
//   2. Log in as you normally would. Take it one step at a time.
//   3. Every time the screen changes, this writes down what is on it.
//   4. It stops once you are signed in, and prints the steps in order.
//
// WHAT IT RECORDS: tag names, classes, placeholders, maxlength, and the text
// of short clickable elements. It never reads the value of any input, so the
// phone number and the code are not in the output. The profile is thrown away.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const ORIGIN = process.env.ORIGIN ?? 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337);
const WAIT_MS = 15 * 60 * 1000;
const OUT_FILE = 'login-form-recon.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'dm-form-'));

interface Shot {
  at: string;
  inputs: { type: string | null; name: string | null; id: string | null; placeholder: string | null; maxLength: number; inputMode: string | null; cls: string }[];
  clickable: { tag: string; cls: string; text: string }[];
  heading: string;
}

// Values are never read. `el.value` does not appear here on purpose.
const SNAP = `(() => {
  const inputs = [];
  for (const el of document.querySelectorAll('input')) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    inputs.push({
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      placeholder: el.getAttribute('placeholder'),
      maxLength: el.maxLength,
      inputMode: el.getAttribute('inputmode'),
      cls: String(el.className || '').slice(0, 60)
    });
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
    clickable.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 60), text: t });
    if (clickable.length >= 25) break;
  }
  const h = document.querySelector('h1, h2, h3');
  return { inputs: inputs, clickable: clickable, heading: h ? (h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '' };
})()`;

const child = spawn(
  CHROME_PATH,
  [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ORIGIN],
  { stdio: 'ignore' },
);

let browser: Browser | null = null;
const steps: Shot[] = [];

try {
  await sleep(3000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await sleep(4000);

  console.log('Log in in the window that opened, one step at a time.');
  console.log('Every screen change is written down. Nothing you type is read.\n');

  const until = Date.now() + WAIT_MS;
  let last = '';
  while (Date.now() < until) {
    await sleep(1000);
    const shot = (await page.evaluate(SNAP).catch(() => null)) as Omit<Shot, 'at'> | null;
    if (!shot) continue;

    // A screen is "new" when its inputs or its short labels change.
    const signature = JSON.stringify([shot.inputs.map((i) => `${i.type}:${i.maxLength}:${i.placeholder}`), shot.heading]);
    if (signature !== last) {
      last = signature;
      steps.push({ at: new Date().toISOString(), ...shot });
      console.log(`--- step ${steps.length}${shot.heading ? `: ${shot.heading}` : ''}`);
      for (const i of shot.inputs) {
        console.log(`    input  type=${i.type} maxLength=${i.maxLength} inputMode=${i.inputMode} placeholder=${JSON.stringify(i.placeholder)} name=${i.name} cls=${i.cls.slice(0, 34)}`);
      }
      const words = shot.clickable.filter((c) => /log\s*in|continue|verify|submit|resend|otp|phone|sign/i.test(c.text));
      for (const c of words.slice(0, 6)) console.log(`    button ${c.tag} "${c.text}" cls=${c.cls.slice(0, 34)}`);
      if (!shot.inputs.length && !words.length) console.log('    (nothing login-ish on screen yet)');
    }

    // Done when the site says who is signed in.
    const done = (await page
      .evaluate(`(() => { try { const u = JSON.parse(localStorage.getItem('user') || '{}'); return u && u.verified === true; } catch (e) { return false; } })()`)
      .catch(() => false)) as boolean;
    if (done) {
      console.log('\nSigned in. Stopping.');
      break;
    }
  }

  writeFileSync(OUT_FILE, JSON.stringify({ capturedAt: new Date().toISOString(), origin: ORIGIN, steps }, null, 1));
  console.log(`\n${steps.length} screens recorded. Written to ${OUT_FILE}.`);
  console.log('No typed value was read, so the phone number and the code are not in it.');
} finally {
  await browser?.close().catch(() => undefined);
  child.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
