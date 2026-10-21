// Instamart recon, part 3 — RESULT: refused. Instamart answers our own add
// with 101 "Spin Id for all items not present" even with the page's exact
// body and device headers (the page also signs each request); only the
// page's own buttons can add (design Appendix C). `--clear` does work.
// Kept as the record of what was tried. The attempt: add with our call: read the cart, merge the new item in, send the whole cart (adding
// sends the full list; sending only the new item would drop the rest).
// Leaves the item in the cart so the household can see it on their phone;
// `--clear` empties the cart again (only use it when it held nothing else).
//
//   npx tsx cart-add.ts <itemId> <spinId> <productId> <storeId> <addressId>
//   npx tsx cart-add.ts --clear
//
import { attachChrome, ORIGIN, pageFetch } from './shared.ts';


const browser = await attachChrome();
const context = browser.contexts()[0];
// A fresh tab first (closing the last one would close the window), then
// close tabs left by earlier runs.
const page = await context.newPage();
for (const p of context.pages()) if (p !== page && p.url().includes('instamart')) await p.close();
await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
await page.waitForTimeout(4000);

const read = async () => JSON.parse((await pageFetch(page, '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME')).body)?.data?.data ?? null;

if (process.argv[2] === '--clear') {
  const r = await pageFetch(page, '/api/instamart/checkout/v2/cart/clear', { method: 'POST', json: { source: 'USER_INITIATED' } });
  console.log(`clear: ${r.status}; items now: ${((await read())?.items ?? []).length}`);
} else {
  const [itemId, spin, productId, storeId, addressId] = process.argv.slice(2);
  // SEARCH="words": search first in this session, as the page does before an add.
  if (process.env.SEARCH) {
    await page.goto(`${ORIGIN}/search?custom_back=true&query=${encodeURIComponent(process.env.SEARCH)}`, { waitUntil: 'load' });
    await page.waitForTimeout(5000);
  }
  const cart = await read();
  type Line = { itemId: string; quantity: number; spin?: string; productId?: string; meta?: unknown };
  const lines: Line[] = (cart?.items ?? []).map((i: Record<string, unknown>) => ({
    quantity: i.quantity as number,
    productId: i.productId as string,
    spin: (i.spin ?? i.spinId) as string,
    itemId: (i.itemId ?? i.id) as string,
    meta: { type: 'structure', storeId: Number((i.meta as { storeId?: number })?.storeId ?? storeId) },
    serviceLine: 'INSTAMART',
  }));
  const had = lines.find((l) => l.itemId === itemId);
  if (had) had.quantity += 1;
  else lines.push({ quantity: 1, productId, spin, itemId, meta: { type: 'structure', storeId: Number(storeId) }, serviceLine: 'INSTAMART' } as Line);
  const body = {
    data: {
      items: lines,
      cartMetaData: {
        contactlessDelivery: false,
        deliveryType: 'INSTANT',
        owner: 'APP',
        preferredAddressId: addressId,
        ageConsentProvided: false,
        useGiftBagPackaging: false,
        useReusablePackaging: false,
        incognitoCart: false,
        includeConsents: ['PHARMA'],
        primaryStoreId: Number(storeId),
        storeIds: [Number(storeId)],
      },
      cartType: 'INSTAMART',
    },
    source: 'userInitiated',
    // What the page sends alongside: the item being changed.
    cartAnalyticsMetaInfo: { actionType: 'ADD_ITEMS', itemInfo: { itemId, quantity: 1, spin, productId } },
  };
  // The page's own headers, minus its per-request signature ("matcher"):
  // the device id it keeps, and its build version (EXTRA_HEADERS as JSON).
  const extra = JSON.parse(process.env.EXTRA_HEADERS ?? '{}') as Record<string, string>;
  const r = (await page.evaluate(`(async () => {
    const r = await fetch('/api/instamart/checkout/v2/cart?pageType=INSTAMART_SEARCH', {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'content-type': 'application/json' }, ${JSON.stringify(extra)}),
      body: ${JSON.stringify(JSON.stringify(body))},
    });
    return { status: r.status, body: await r.text() };
  })()`)) as { status: number; body: string };
  const res = JSON.parse(r.body)?.data;
  const now = res?.data;
  console.log(`add: ${r.status} status ${res?.statusCode} ${res?.statusMessage ?? ''}`);
  console.log(`cart now: ${JSON.stringify((now?.items ?? []).map((i: Record<string, unknown>) => [i.itemId ?? i.id, i.quantity]))}`);
  console.log(`bill: item total ${now?.bill?.itemTotal}, to pay ${now?.bill?.toPay}, surge ${now?.bill?.surgeFee}; serving: ${JSON.stringify(now?.storesInfo?.[0]?.serviceabilityDetails ?? now?.shipmentDetails?.[0]?.serviceabilityDetails ?? null)}`);
}
await page.close();
await browser.close();
