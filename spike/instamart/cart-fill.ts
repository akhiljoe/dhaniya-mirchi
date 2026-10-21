// Instamart recon, part 4 — fill the cart the way the worker will (design
// §19 Ordering, Appendix C): for each wanted product, search for it, find
// its exact pack in Instamart's own search data (name + pack label), check
// stock, then tap through the page's own buttons (+, the pack picker's ADD,
// + for more, Confirm). Then read the cart back and check every line.
//
//   npx tsx cart-fill.ts '<json list>'
//     [{"name": "Nandini Pasteurised Toned Milk", "pack": "500 ml", "qty": 2}, ...]
//
// CLEAR_TEST_ITEMS=a,b,c first empties the cart, but only when it holds
// nothing except those item ids (our own test items); it also deletes the
// page's saved copy of the cart, which otherwise puts removed items back.
import type { Page } from 'playwright';

import { attachChrome, ORIGIN, pageFetch } from './shared.ts';

interface Want {
  name: string;
  pack: string;
  qty: number;
}
interface Variation {
  skuId: string;
  displayName: string;
  quantityDescription: string;
  price?: { offerPrice?: { units?: string } };
  inventory?: { inStock?: boolean };
  imageIds?: string[];
}

const wants = JSON.parse(process.argv[2] ?? '[]') as Want[];
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const readCart = async (page: Page): Promise<{ itemId: string; quantity: number; name: string }[]> => {
  const d = JSON.parse((await pageFetch(page, '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME')).body)?.data?.data;
  return (d?.items ?? []).map((i: Record<string, unknown>) => ({ itemId: String(i.itemId ?? i.id), quantity: i.quantity as number, name: String(i.displayName ?? i.name ?? '') }));
};

// The page's saved copy of the cart (IndexedDB keyval-store → "instacart").
const forgetSavedCart = (page: Page) =>
  page.evaluate(`new Promise((ok) => {
    const req = indexedDB.open('keyval-store');
    req.onsuccess = () => {
      const tx = req.result.transaction(['keyval'], 'readwrite');
      tx.objectStore('keyval').delete('instacart');
      tx.oncomplete = () => ok(true);
      tx.onerror = () => ok(false);
    };
    req.onerror = () => ok(false);
  })`);

const browser = await attachChrome();
const context = browser.contexts()[0];
const page = await context.newPage();
for (const p of context.pages()) if (p !== page && p.url().includes('instamart')) await p.close();
await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
await page.waitForTimeout(4000);

let cart = await readCart(page);
console.log('cart before:', JSON.stringify(cart.map((l) => [l.quantity, l.name || l.itemId])));
if (process.env.CLEAR_TEST_ITEMS) {
  const ours = new Set(process.env.CLEAR_TEST_ITEMS.split(','));
  if (cart.every((l) => ours.has(l.itemId))) {
    await pageFetch(page, '/api/instamart/checkout/v2/cart/clear', { method: 'POST', json: { source: 'USER_INITIATED' } });
    await forgetSavedCart(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
    cart = await readCart(page);
    console.log(`cleared our test items; cart now has ${cart.length} lines`);
  } else {
    console.log('The cart holds items that are not ours: not clearing.');
  }
}

const done: { want: Want; skuId: string | null; note: string }[] = [];
for (const want of wants) {
  const searched = page.waitForResponse((r) => r.url().includes('/api/instamart/search/v2') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.goto(`${ORIGIN}/search?custom_back=true&query=${encodeURIComponent(want.name)}`, { waitUntil: 'load' });
  const body = await (await searched).text();
  await page.waitForTimeout(3000);
  const tip = page.getByText(/^got it!?$/i).first();
  if (await tip.count()) await tip.click().catch(() => {});

  // The exact product and pack, from Instamart's own data.
  const variations: Variation[] = [];
  const products: { variations: Variation[] }[] = [];
  JSON.parse(body, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.skuId === 'string' && typeof v.displayName === 'string') variations.push(v);
    if (v && typeof v === 'object' && Array.isArray(v.variations)) products.push(v);
    return v;
  });
  const v = variations.find((x) => norm(x.displayName) === norm(want.name) && norm(x.quantityDescription) === norm(want.pack));
  if (!v) {
    done.push({ want, skuId: null, note: `not found at this store (packs seen: ${[...new Set(variations.filter((x) => norm(x.displayName) === norm(want.name)).map((x) => x.quantityDescription))].join(', ') || 'none'})` });
    continue;
  }
  if (v.inventory?.inStock === false) {
    done.push({ want, skuId: v.skuId, note: 'out of stock' });
    continue;
  }
  const price = v.price?.offerPrice?.units ?? '';

  // The product's card. Names can't be matched as text: Instamart scrambles
  // them on the page ("Nandini Pa teuri ed Toned Milk"). And one product can
  // have several listings with one name (Milky Mist Set Curd: 1 kg, 200 g).
  // So the card is found by its image: the image files of the listing that
  // holds the wanted pack, as Instamart's own search data names them.
  const listing = (products.find((p) => p.variations.includes(v)) ?? { variations: [v] }).variations;
  const imageKeys = [...new Set(listing.flatMap((x) => x.imageIds ?? []).map((id) => id.split('/').pop()!).filter((k) => k.length >= 12))];
  const plusIndex = (await page.evaluate(`(() => {
    const keys = ${JSON.stringify(imageKeys)};
    const plus = [...document.querySelectorAll('[data-testid="buttonpair-add"]')];
    return plus.findIndex((b) => {
      let x = b.parentElement;
      // Up to the card: the largest block holding only this one +.
      while (x.parentElement && x.parentElement.querySelectorAll('[data-testid="buttonpair-add"]').length === 1) x = x.parentElement;
      const srcs = [...x.querySelectorAll('img')].map((i) => decodeURIComponent(i.currentSrc || i.src || ''));
      return srcs.some((s) => keys.some((k) => s.includes(k)));
    });
  })()`)) as number;
  if (plusIndex < 0) {
    done.push({ want, skuId: v.skuId, note: 'no card shows this pack; not added' });
    continue;
  }
  // The cart should HOLD want.qty: only the difference is added or removed
  // (adding "2 milk" to a cart that has 2 must not make 4).
  const have = (await readCart(page)).find((l) => l.itemId === v.skuId)?.quantity ?? 0;
  const delta = want.qty - have;
  if (delta === 0) {
    done.push({ want, skuId: v.skuId, note: `already ${have} in the cart` });
    continue;
  }
  const card = page.locator('[data-testid="buttonpair-add"]').nth(plusIndex);
  await card.scrollIntoViewIfNeeded();
  // With some already in the cart, the card shows − n +; its + (or −) opens
  // the picker for a product with packs.
  if (have > 0 && delta < 0) {
    await card.locator('xpath=ancestor::*[.//*[@data-testid="buttonpair-remove"]][1]').locator('[data-testid="buttonpair-remove"]').first().click();
  } else {
    await card.click();
  }
  await page.waitForTimeout(2500);

  const confirm = page.getByText(/^confirm$/i).first();
  if (await confirm.isVisible().catch(() => false)) {
    // The pack picker: one row per pack (variants-container), each with its
    // name parts ("500 ml", "x 2"), its price, and ADD / + / −. The wanted row
    // has exactly this pack's name and this price; never chosen by position.
    const rows = page.locator('[data-testid="variants-container"]');
    let row = null;
    for (let i = 0; i < (await rows.count()); i++) {
      const r = rows.nth(i);
      const names = (await r.locator('[data-testid="variants-name"]').allTextContents()).map(norm).join(' ');
      const rowPrice = (await r.locator('[data-testid="variants-price"]').first().textContent())?.trim();
      if (names === norm(want.pack) && rowPrice === price) row = r;
    }
    if (!row) {
      await page.screenshot({ path: `fill_nopack_${done.length}.tmp.png` });
      await page.keyboard.press('Escape');
      done.push({ want, skuId: v.skuId, note: `no ${want.pack} at ₹${price} in the picker` });
      continue;
    }
    // The picker shows this pack's count as it is in the cart: ADD when
    // none, else − n +. Step it to the wanted count.
    let steps = Math.abs(delta);
    if (have === 0) {
      await row.locator('[data-testid="add_buttons_center"]').click();
      await page.waitForTimeout(1500);
      steps -= 1;
    }
    for (let i = 0; i < steps; i++) {
      await row.locator(`[data-testid="${delta > 0 ? 'add_buttons_plus' : 'add_buttons_minus'}"]`).click();
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: `fill_picker_${done.length}.tmp.png` });
    await confirm.click();
  } else {
    // One pack only: the card's own − n + steps the count (the first tap above
    // already moved it by one).
    for (let i = 1; i < Math.abs(delta); i++) {
      const pair = card.locator('xpath=ancestor::*[.//*[@data-testid="buttonpair-remove"]][1]');
      await pair.locator(`[data-testid="${delta > 0 ? 'buttonpair-add' : 'buttonpair-remove'}"]`).first().click();
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForTimeout(3000);
  done.push({ want, skuId: v.skuId, note: `₹${price} each` });
}

cart = await readCart(page);
console.log('cart after:', JSON.stringify(cart.map((l) => [l.quantity, l.name || l.itemId, l.itemId])));
for (const d of done) {
  const line = cart.find((l) => l.itemId === d.skuId);
  const ok = !!line && line.quantity === d.want.qty;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${d.want.qty} × ${d.want.name}, ${d.want.pack}: ${d.note}${line ? `; in cart ${line.quantity}` : '; not in cart'}`);
}
const extra = cart.filter((l) => !done.some((d) => d.skuId === l.itemId));
if (extra.length) console.log('Also in the cart:', JSON.stringify(extra.map((l) => [l.quantity, l.name || l.itemId])));
await page.close();
await browser.close();
