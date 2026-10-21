// Checkout recon for Instamart — WATCH ONLY. Nothing is clicked, nothing is
// paid. The household drives; this writes down what the page did.
//
// Design §19 stage 3 says a relayed bank OTP may be built "only after a
// recorded checkout shows it works". This is that recording. What it is for:
//
//   - is the payment a Razorpay/Juspay iframe, or a redirect to the bank?
//   - does a 3-D Secure page appear at all on this account's saved card, or
//     does it clear without a challenge (which would mean automating payment
//     spends money with nothing to stop a mistake)?
//   - what does "order placed" look like, so a paid-but-no-order state can be
//     told apart from a failure?
//
// The browser is the household's own session, restored from the vault the way
// the worker restores it, in a REAL Chrome spawned as a process and attached
// to over CDP - never a Playwright-launched browser, which Instamart blocks
// at the first page load (design Appendix C).
//
//   npx tsx --env-file=../../.env spike/instamart/capture-checkout.ts
//
// It stops itself the moment a bank challenge page appears, so the OTP is
// never in its reach, and scrubs anything card-number shaped before writing.
// checkout-recon.json holds the delivery address and the card's token: it is
// gitignored, and should be deleted once the decision is made.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';

import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { INSTAMART_ORIGIN } from '../../server/src/constants.js';

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const USER_DATA_DIR = './.checkoutdata';
const OUT_FILE = 'checkout-recon.json';
const PHONE_LAST4 = process.env.PHONE_LAST4 ?? '4567';
const WATCH_TIMEOUT_MS = 15 * 60 * 1000;
const BODY_LIMIT = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Call {
  at: string;
  method: string;
  url: string;
  host: string;
  postData: string | null;
  status: number | null;
  body: string | null;
}

// A card's own digits never appear here (the vendor holds the card as a
// token), but a recording is not the place to find that out the hard way.
function scrub(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[card-number-removed]')
    .replace(/("(?:cvv|cvc|card_number|cardNumber|pan)"\s*:\s*)"[^"]*"/gi, '$1"[removed]"');
}

function mask(s: string): string {
  return s.replace(/\d{4,}/g, (d) => `${d.slice(0, 2)}${'*'.repeat(Math.max(0, d.length - 2))}`).replace(/([A-Za-z0-9_-]{24,})/g, (t) => `${t.slice(0, 6)}…`);
}

const PAYMENT_HINT = /pay|payment|checkout|order|txn|transaction|razorpay|juspay|paytm|payu|cashfree|billdesk|upi/i;
const CHALLENGE_HINT = /acs|3ds|threeds|secure|otp|challenge|authenticate/i;

function isOurs(host: string): boolean {
  return host.endsWith('instamart.in') || host.endsWith('swiggy.com');
}

function isChallenge(url: string): boolean {
  try {
    const u = new URL(url);
    return !isOurs(u.hostname) && CHALLENGE_HINT.test(u.href);
  } catch {
    return false;
  }
}

async function attachChrome(startUrl: string): Promise<Browser> {
  const up = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(
    () => true,
    () => false,
  );
  if (!up) {
    const chrome = spawn(
      CHROME_PATH,
      [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${resolve(USER_DATA_DIR)}`, '--no-first-run', '--no-default-browser-check', startUrl],
      { stdio: 'ignore', detached: true },
    );
    chrome.on('error', (e) => {
      console.error(`[fail] could not start Chrome at ${CHROME_PATH}: ${e.message}`);
      process.exit(1);
    });
    chrome.unref();
  }
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw last;
}

function watch(page: Page, calls: Call[], onChallenge: (url: string) => void): void {
  page.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
    let host = '';
    try {
      host = new URL(res.url()).hostname;
    } catch {
      return;
    }
    if (!isOurs(host) && !isChallenge(res.url()) && !PAYMENT_HINT.test(res.url())) return;
    let body: string | null = null;
    try {
      const ct = (await res.headerValue('content-type')) ?? '';
      if (/json|text\/plain/i.test(ct)) body = (await res.text()).slice(0, BODY_LIMIT);
    } catch {
      body = null;
    }
    calls.push({ at: new Date().toISOString(), method: req.method(), url: res.url(), host, postData: scrub(req.postData()), status: res.status(), body: scrub(body) });
    if (isChallenge(res.url())) onChallenge(res.url());
  });
  page.on('framenavigated', (frame) => {
    if (isChallenge(frame.url())) onChallenge(frame.url());
  });
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; session_sealed: string }>(
    `select id, session_sealed from vendor_connections where vendor = 'instamart' and phone_last4 = $1 order by created_at limit 1`,
    [PHONE_LAST4],
  );
  if (!rows.length) throw new Error(`no Instamart connection ending ${PHONE_LAST4}`);
  const conn = rows[0]!;
  const session = JSON.parse(openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
  await db.end();

  const calls: Call[] = [];
  let challengeAt: string | null = null;
  const onChallenge = (url: string) => {
    if (!challengeAt) {
      challengeAt = url;
      console.log(`\n[stop] a bank challenge page appeared: ${mask(url)}`);
      console.log('       Nothing further is recorded. Your OTP is never seen by this script.');
    }
  };

  const browser = await attachChrome('about:blank');
  const context = browser.contexts()[0]!;
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
    `if (location.origin === ${JSON.stringify(INSTAMART_ORIGIN)}) {
       const s = ${JSON.stringify(session.localStorage)};
       for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
     }`,
  );
  for (const p of context.pages()) watch(p, calls, onChallenge);
  context.on('page', (p) => watch(p, calls, onChallenge));

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });

  console.log('\n=================================================================');
  console.log(' WATCH ONLY. This script clicks nothing and pays for nothing.');
  console.log('');
  console.log(' A Chrome window is open on Instamart, signed in as your household.');
  console.log('');
  console.log(' 1. Check the cart holds what you expect (something cheap).');
  console.log(' 2. Go to checkout and pick the saved card.');
  console.log(' 3. Tap Pay yourself.');
  console.log('');
  console.log(' It stops as soon as a bank page or a payment result appears.');
  console.log(' Afterwards, check the app whether an order was really placed.');
  console.log('=================================================================\n');

  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  while (Date.now() < deadline && !challengeAt) await sleep(1000);
  await sleep(2000);

  writeFileSync(OUT_FILE, JSON.stringify({ capturedAt: new Date().toISOString(), origin: INSTAMART_ORIGIN, challengeSeen: challengeAt, calls }, null, 2));

  const payments = calls.filter((c) => PAYMENT_HINT.test(c.url) || !isOurs(c.host));
  console.log(`\n[ok] ${calls.length} calls recorded (${payments.length} payment-shaped) → ${OUT_FILE}`);
  for (const c of payments.slice(-20)) {
    console.log(`\n${c.method} ${mask(c.url)}  → ${c.status}`);
    if (c.postData) console.log(`  request: ${mask(c.postData).slice(0, 200)}`);
    if (c.body) console.log(`  answer : ${mask(c.body).slice(0, 200)}`);
  }
  console.log(`\n--- the answer we came for ---`);
  console.log(
    challengeAt
      ? `  A bank challenge DID appear: ${mask(challengeAt)}\n  So a card payment here is gated by an OTP, and relaying it (§19 stage 3)\n  is the only way to automate this.`
      : `  No bank challenge appeared within the watch window. Either the payment\n  was never started, or this card clears without one - check the order list\n  before assuming the first.`,
  );
  console.log(`\n${OUT_FILE} holds the delivery address and the card's token. Gitignored. Delete it when the decision is made.`);
  await browser.close();
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
