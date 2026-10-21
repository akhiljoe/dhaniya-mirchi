// Checkout recon — WATCH ONLY. Nothing is clicked, nothing is paid.
//
// Design §19 stage 3 says a relayed bank OTP may be built "only after a
// recorded checkout shows it works headless". This is that recording, and it
// answers the question it was asked for: with a saved card, does the payment
// actually stop at a bank OTP, or does it go through without one?
//
// The honest reason this script does not press the buttons itself: a saved
// card can clear under risk-based ("frictionless") 3-D Secure, where the
// issuer approves with no challenge at all. There is no way to know which
// path an account takes until the money has already moved. So the human
// drives the checkout and this only writes down what the page did.
//
//   npm run capture:checkout
//   ORIGIN=https://www.swiggy.com npm run capture:checkout   # the other app
//
// How to run it, and the one rule:
//   1. Put ONE CHEAP ITEM in the cart. If the payment turns out to be
//      frictionless, that single item is the whole cost of finding out.
//   2. Go to checkout and choose the saved card, as you normally would.
//   3. Tap Pay. The script stops itself the moment a bank challenge page or a
//      payment result appears, and writes what it saw.
//   4. Whether you finish the payment or abandon it is your call. Either way,
//      check the app's order list afterwards - `npm run extract` reads it -
//      to see whether an order was placed.
//
// checkout-recon.json holds the delivery address, the card token and last
// digits, and the payment endpoints. It never holds a card number (the page
// never has one: the card is a token at the vendor) and it never holds the
// bank OTP - the script stops before that is typed. It is gitignored.
//
// KEEP IT until a payment has actually gone through. The first capture was
// deleted as soon as the design decision looked made, and the one fact that
// turned out to matter - how the zpaykit access token is carried - had not
// been taken out of it yet, which cost a whole second capture. Run
// extract-payment-chain.ts against it instead: that prints the endpoints,
// header names and where each secret travels, with no secret's value, and
// what it prints is what goes in the design doc.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const ORIGIN = process.env.ORIGIN ?? 'https://blinkit.com';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9335); // 9333 instamart, 9334 the login recon
const USER_DATA_DIR = './.logindata'; // the profile the login recon left signed in
const OUT_FILE = 'checkout-recon.json';
const WATCH_TIMEOUT_MS = 15 * 60 * 1000;
// Generous on purpose: at 4000 the saved-card list was cut off mid-answer,
// so the card fields had to be read from a later capture. The file is local
// and gitignored, and holding a few hundred KB of it costs nothing next to
// asking the household to drive the checkout again.
const BODY_LIMIT = 200_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RecordedCall {
  at: string;
  method: string;
  url: string;
  host: string;
  requestHeaders: Record<string, string>;
  postData: string | null;
  status: number | null;
  body: string | null;
}

// A card's own digits never appear here (the vendor holds the card as a
// token), but a recording is not the place to find that out the hard way:
// anything that looks like a PAN or a CVV is cut before it is written.
function scrub(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[card-number-removed]')
    .replace(/("(?:cvv|cvc|card_number|cardNumber|pan)"\s*:\s*)"[^"]*"/gi, '$1"[removed]"');
}

// The console is a shared screen: long digit runs and token-shaped values are
// masked there. The file keeps the rest verbatim, because the adapter would be
// written against the real shapes.
function mask(s: string): string {
  return s
    .replace(/\d{4,}/g, (d) => `${d.slice(0, 2)}${'*'.repeat(Math.max(0, d.length - 2))}`)
    .replace(/([A-Za-z0-9_-]{24,})/g, (t) => `${t.slice(0, 6)}…(${t.length} chars)`);
}

// What a payment step looks like from the outside: the vendor's own payment
// calls, and the bank's 3-D Secure page, which lives on someone else's domain.
const PAYMENT_HINT = /pay|payment|checkout|order\/place|place_order|txn|transaction|razorpay|juspay|paytm|payu|cashfree|billdesk/i;
const CHALLENGE_HINT = /wibmo|acs|3ds|threeds|secure|paytm|juspay|razorpay|payu|billdesk|cashfree/i;
// Never the bank, however much the URL looks like it. This list is why: a run
// on 2026-09-22 stopped before the cart was even filled, because a Google Ads
// conversion pixel matched on "conversion" and the script declared a bank
// challenge. It recorded thirteen home-page calls and exited.
const NOT_BANK = [
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'googletagmanager.com',
  'google-analytics.com',
  'googleapis.com',
  'gstatic.com',
  'google.com',
  'facebook.com',
  'facebook.net',
  'clarity.ms',
  'hotjar.com',
  'segment.io',
  'branch.io',
  'appsflyer.com',
  'moengage.com',
  'clevertap.com',
  'amplitude.com',
  'sentry.io',
  'newrelic.com',
  'cloudflareinsights.com',
];

// The HOST decides, not the whole URL: an ad pixel carries these words in its
// query string, a bank carries them in its domain.
function isChallenge(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('blinkit.com') || host.endsWith('swiggy.com')) return false;
    if (NOT_BANK.some((h) => host === h || host.endsWith(`.${h}`))) return false;
    return CHALLENGE_HINT.test(host);
  } catch {
    return false;
  }
}

function launchChrome(startUrl: string): void {
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
      await sleep(500);
    }
  }
  throw last;
}

function watch(page: Page, calls: RecordedCall[], onChallenge: (url: string) => void): void {
  page.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'xhr' && type !== 'fetch' && type !== 'document') return;
    const url = req.url();
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    const ours = host.endsWith('blinkit.com') || host.endsWith('swiggy.com');
    if (!ours && !isChallenge(url) && !PAYMENT_HINT.test(url)) return;
    let body: string | null = null;
    try {
      const contentType = (await res.headerValue('content-type')) ?? '';
      if (/json|text\/plain/i.test(contentType)) body = (await res.text()).slice(0, BODY_LIMIT);
    } catch {
      body = null;
    }
    calls.push({
      at: new Date().toISOString(),
      method: req.method(),
      url,
      host,
      requestHeaders: req.headers(),
      postData: scrub(req.postData()),
      status: res.status(),
      body: scrub(body),
    });
    if (isChallenge(url)) onChallenge(url);
  });
  // A bank challenge usually arrives as a page or an iframe, not an XHR.
  page.on('framenavigated', (frame) => {
    if (isChallenge(frame.url())) onChallenge(frame.url());
  });
}

async function main() {
  const calls: RecordedCall[] = [];
  let challengeAt: string | null = null;
  const onChallenge = (url: string) => {
    if (!challengeAt) {
      challengeAt = url;
      console.log(`\n[stop] a bank challenge page appeared: ${mask(url)}`);
      console.log('       Nothing further is recorded. Your OTP is never seen by this script.');
    }
  };

  const browser = await attachChrome(`${ORIGIN}/`);
  const context = browser.contexts()[0];
  for (const p of context.pages()) watch(p, calls, onChallenge);
  context.on('page', (p) => watch(p, calls, onChallenge));

  console.log('\n=================================================================');
  console.log(' WATCH ONLY. This script clicks nothing and pays for nothing.');
  console.log('');
  console.log(' 1. Put ONE CHEAP ITEM in the cart.');
  console.log(' 2. Go to checkout and pick your saved card.');
  console.log(' 3. Tap Pay yourself.');
  console.log('');
  console.log(' It stops as soon as a bank page or a payment result appears.');
  console.log(' Afterwards, check the app whether an order was actually placed.');
  console.log('=================================================================\n');

  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  while (Date.now() < deadline && !challengeAt) await sleep(1000);
  // A moment for the last few calls of that step to land.
  await sleep(2000);

  const payments = calls.filter((c) => PAYMENT_HINT.test(c.url) || c.host.endsWith('blinkit.com') === false);
  writeFileSync(
    OUT_FILE,
    JSON.stringify({ capturedAt: new Date().toISOString(), origin: ORIGIN, challengeSeen: challengeAt, calls }, null, 2),
  );

  console.log(`\n[ok] ${calls.length} calls recorded (${payments.length} payment-shaped) → ${OUT_FILE}`);
  console.log(`\n--- payment-shaped calls ---------------------------------------`);
  for (const c of payments.slice(-25)) {
    console.log(`\n${c.method} ${mask(c.url)}  → ${c.status}`);
    if (c.postData) console.log(`  request: ${mask(c.postData).slice(0, 200)}`);
    if (c.body) console.log(`  answer : ${mask(c.body).slice(0, 200)}`);
  }
  console.log(`\n--- the answer we came for -------------------------------------`);
  console.log(
    challengeAt
      ? `  A bank challenge DID appear: ${mask(challengeAt)}\n  So a card payment on this account is gated by an OTP, and design §19\n  stage 3 (relaying it) is the only way to automate it.`
      : `  No bank challenge appeared within the watch window.\n  Either the payment was never started, or this account's card clears\n  without a challenge - check the app's order list before assuming the\n  first. A card that clears frictionlessly means automating payment would\n  spend money with nothing to stop a mistake.`,
  );
  console.log(`\n${OUT_FILE} holds the delivery address and the card's token. Gitignored. Delete it when the decision is made.`);

  await browser.close();
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
