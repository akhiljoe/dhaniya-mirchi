// Instamart recon, part 2 — does adding send the whole cart, or only the
// change? And do our own in-page calls work without the page's signing
// header ("matcher")? Adds two products through the page (single packs),
// then, only if the cart was empty to begin with, clears it with our own
// call. Logs to cart_log2.tmp.jsonl (gitignored).
//
//   npx tsx cart-recon2.ts ["search words" ...]      KEEP=1 to leave them in the cart
//
import { appendFileSync } from 'node:fs';
import type { Page, Response } from 'playwright';

import { attachChrome, ORIGIN, pageFetch } from './shared.ts';

const LOG = 'cart_log2.tmp.jsonl';
// Search words from the command line; KEEP=1 leaves them in the cart.
const QUERIES = process.argv.slice(2).length ? process.argv.slice(2) : ['nandini toned milk', 'nandini curd'];
let step = 'start';

async function record(res: Response): Promise<void> {
  const req = res.request();
  if (!['xhr', 'fetch'].includes(req.resourceType()) || !/instamart\.in/.test(req.url())) return;
  if (!/checkout|search\/v2|select-location/.test(req.url())) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '<unreadable>';
  }
  appendFileSync(LOG, JSON.stringify({ step, method: req.method(), url: req.url(), status: res.status(), postData: req.postData(), body: body.slice(0, 1_000_000) }) + '\n');
  console.log(`  [${step}] ${req.method()} ${res.status()} ${req.url().split('?')[0]}`);
}

const cartCount = async (page: Page) => {
  const r = await pageFetch(page, '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME');
  try {
    return (JSON.parse(r.body)?.data?.data?.items ?? []).length as number;
  } catch {
    return -1;
  }
};

async function addFirst(page: Page, query: string) {
  step = `search:${query}`;
  await page.goto(`${ORIGIN}/search?custom_back=true&query=${encodeURIComponent(query)}`, { waitUntil: 'load' });
  await page.waitForTimeout(5000);
  const tip = page.getByText(/^got it!?$/i).first();
  if (await tip.count()) await tip.click().catch(() => {});
  step = `add:${query}`;
  const plus = page.locator('[data-testid="buttonpair-add"]').first();
  await plus.scrollIntoViewIfNeeded();
  await plus.click();
  await page.waitForTimeout(2500);
  const confirm = page.getByText(/^confirm$/i).first();
  if (await confirm.isVisible().catch(() => false)) {
    await page.getByText(/^add$/i).last().click();
    await page.waitForTimeout(1500);
    await confirm.click();
  }
  await page.waitForTimeout(4000);
}

const browser = await attachChrome();
const context = browser.contexts()[0];
context.on('response', (r) => void record(r));
// A fresh tab first (closing the last one would close the window), then
// close tabs left by earlier runs.
const page = await context.newPage();
for (const p of context.pages()) if (p !== page && p.url().includes('instamart')) await p.close();
await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
await page.waitForTimeout(4000);

const start = await cartCount(page);
console.log(`cart before: ${start} items`);
for (const q of QUERIES) await addFirst(page, q);
console.log(`cart after adding: ${await cartCount(page)} items`);

step = 'clear';
if (process.env.KEEP) {
  console.log('KEEP: left in the cart.');
} else if (start === 0) {
  const r = await pageFetch(page, '/api/instamart/checkout/v2/cart/clear', { method: 'POST', json: { source: 'USER_INITIATED' } });
  console.log(`our own clear call: ${r.status} ${r.body.slice(0, 120)}`);
} else {
  console.log('The cart was not empty to begin with: not clearing. Remove the two test items by hand.');
}
console.log(`cart at the end: ${await cartCount(page)} items`);
await page.close();
await browser.close();
