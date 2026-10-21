// Instamart recon — the cart (design §19 Ordering, stage 1 "cart handoff").
//
// Records how instamart.in's own web app finds a product, tells whether it is
// in stock at the household's store, and adds it to / removes it from the
// cart. It drives the real page like a person would: search, tap Add, tap the
// minus. Every JSON call on an Instamart host is appended to
// cart_log.tmp.jsonl (gitignored: it holds live session headers).
//
// It works on YOUR real cart. The cart is read first and saved to
// cart_before.tmp.json; the script only ever removes what it added itself,
// and checks at the end that the cart is back as it was. Nothing is ordered;
// checkout is never opened.
//
//   npx tsx cart-recon.ts ["search words"]      (default: nandini toned milk)
//
import { appendFileSync, writeFileSync } from 'node:fs';
import type { Response } from 'playwright';

import { attachChrome, ORIGIN, pageFetch, sleep } from './shared.ts';

const LOG = 'cart_log.tmp.jsonl';
const QUERY = process.argv[2] ?? 'nandini toned milk';
const HOSTS = ['swiggy.com', 'instamart.in'];

function recorded(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

let step = 'start';
async function record(res: Response): Promise<void> {
  const req = res.request();
  if (!['xhr', 'fetch'].includes(req.resourceType()) || !recorded(req.url())) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '<unreadable>';
  }
  appendFileSync(
    LOG,
    JSON.stringify({ t: new Date().toISOString(), step, method: req.method(), url: req.url(), status: res.status(), requestHeaders: req.headers(), postData: req.postData(), body: body.slice(0, 2_000_000) }) + '\n',
  );
  console.log(`  [${step}] ${req.method()} ${res.status()} ${req.url().split('?')[0]}`);
}

// A cart as { itemId: quantity }, whatever its exact shape: every object with
// an item id and a quantity. Only for comparing before and after.
function cartLines(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      const id = r.itemId ?? r.item_id ?? r.skuId ?? r.spinId;
      const q = r.quantity ?? r.qty;
      if ((typeof id === 'string' || typeof id === 'number') && typeof q === 'number') out[String(id)] = q;
      Object.values(r).forEach(walk);
    }
  };
  try {
    walk(JSON.parse(body));
  } catch {
    /* not JSON: no lines */
  }
  return out;
}

const browser = await attachChrome();
const context = browser.contexts()[0];
context.on('response', (r) => void record(r));
// Tabs left by an earlier run would confuse which page is which.
// A fresh tab first (closing the last one would close the window), then
// close tabs left by earlier runs.
const page = await context.newPage();
for (const p of context.pages()) if (p !== page && p.url().includes('instamart')) await p.close();

step = 'open';
await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
await page.waitForTimeout(4000);

// The store (and so stock and price) depends on the delivery address: a
// fresh session asks for one first. Pick the household's usual one.
step = 'address';
const ADDRESS = process.env.ADDRESS ?? 'Maple Residency';
const saved = page.getByText(ADDRESS).first();
if (await saved.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
  await saved.click();
  await page.waitForTimeout(5000);
  console.log(`address: picked ${ADDRESS}`);
}
await page.screenshot({ path: 'cart_address.tmp.png' });

step = 'cart-before';
const before = await pageFetch(page, '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME');
writeFileSync('cart_before.tmp.json', before.body);
const beforeLines = cartLines(before.body);
console.log(`cart before: ${before.status}, ${Object.keys(beforeLines).length} lines`);

step = 'search';
const box = page.locator('input[placeholder*="Search" i], input[type="search"], [data-testid*="search" i] input').first();
if (!(await box.count())) {
  // The home page shows a search bar that opens the search page when tapped.
  await page.getByText(/search for/i).first().click({ timeout: 10_000 });
  await page.waitForTimeout(1500);
}
await page.locator('input[placeholder*="Search" i], input[type="search"]').first().fill(QUERY);
await page.keyboard.press('Enter');
await page.waitForTimeout(5000);
await page.screenshot({ path: 'cart_search.tmp.png' });

step = 'add';
// A first-visit tip ("Refine results… Got it!") covers the first card.
const tip = page.getByText(/^got it!?$/i).first();
if (await tip.count()) await tip.click().catch(() => {});
// What the page offers as buttons near the results, for the record.
const buttons = await page.evaluate(`[...document.querySelectorAll('button, [role=button]')].slice(0, 40).map((b) =>
  [b.tagName, b.getAttribute('aria-label'), b.getAttribute('data-testid'), (b.textContent || '').trim().slice(0, 30)].join(' | '))`);
writeFileSync('cart_buttons.tmp.json', JSON.stringify(buttons, null, 1));
const target = page.locator('[data-testid="buttonpair-add"]').first();
if (!(await target.count())) {
  console.log('No Add button found; see cart_search.tmp.png. Stopping without changing the cart.');
  await page.close();
  await browser.close();
  process.exit(0);
}
await target.scrollIntoViewIfNeeded();
await target.click();
await page.waitForTimeout(2500);
// A product with several packs opens a picker (500 ml ×4, ×2, single) with
// its own ADD per pack and a Confirm. Take the last row (the single pack).
const confirm = page.getByText(/^confirm$/i).first();
if (await confirm.isVisible().catch(() => false)) {
  await page.screenshot({ path: 'cart_picker.tmp.png' });
  await page.getByText(/^add$/i).last().click();
  await page.waitForTimeout(2000);
  await confirm.click();
}
await page.waitForTimeout(4000);
await page.screenshot({ path: 'cart_added.tmp.png' });
const pairButtons = await page.evaluate(`[...document.querySelectorAll('[data-testid^="buttonpair"]')].slice(0, 6).map((b) =>
  [b.getAttribute('aria-label'), b.getAttribute('data-testid'), (b.textContent || '').trim().slice(0, 20)].join(' | '))`);
console.log('after add:', JSON.stringify(pairButtons));

step = 'cart-after-add';
const after = await pageFetch(page, '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME');
const afterLines = cartLines(after.body);
const added = Object.keys(afterLines).filter((k) => (afterLines[k] ?? 0) > (beforeLines[k] ?? 0));
console.log(`cart after add: ${Object.keys(afterLines).length} lines; added: ${added.join(', ') || 'nothing seen'}`);
console.log('Pausing 20 s: check the cart in the Instamart app on your phone now.');
await sleep(20_000);

step = 'remove';
// The card's + is now a − n + pair; for a product with packs, − opens the
// picker again, where the pack's own − and Confirm undo the add.
const pair = await page.evaluate(`[...document.querySelectorAll('[data-testid], [aria-label]')]
  .filter((b) => /remove|minus|decrement|decrease|subtract/i.test((b.getAttribute('data-testid') || '') + ' ' + (b.getAttribute('aria-label') || '')))
  .slice(0, 8).map((b) => [b.tagName, b.getAttribute('aria-label'), b.getAttribute('data-testid')].join(' | '))`);
console.log('minus-like:', JSON.stringify(pair));
const minus = page.locator('[data-testid*="remove" i]:visible, [aria-label*="remove" i]:visible, [aria-label*="decrease" i]:visible').first();
if (await minus.count()) {
  await minus.click({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'cart_minus.tmp.png' });
  const again = page.getByText(/^confirm$/i).first();
  if (await again.isVisible().catch(() => false)) {
    const inner = page.locator('[data-testid*="remove" i]:visible, [aria-label*="remove" i]:visible').last();
    if (await inner.count()) await inner.click();
    await page.waitForTimeout(2000);
    await again.click();
  }
  await page.waitForTimeout(3000);
} else {
  console.log('No minus button found: remove the test item by hand if it is still in the cart.');
}
await page.screenshot({ path: 'cart_removed.tmp.png' });

step = 'cart-end';
const end = await pageFetch(page, '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME');
const endLines = cartLines(end.body);
const same = JSON.stringify(Object.entries(endLines).sort()) === JSON.stringify(Object.entries(beforeLines).sort());
console.log(same ? 'Cart is back as it was.' : `CART DIFFERS from before: ${JSON.stringify(endLines)} vs ${JSON.stringify(beforeLines)}`);

await page.close();
await browser.close(); // detaches; the spike Chrome stays open
