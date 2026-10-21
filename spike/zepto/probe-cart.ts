// Can we fill a Zepto cart, and does the household's own phone then show it?
//
// The recording (design Appendix D) showed the cart kept in the page's
// localStorage until it is opened, then sent whole: `POST cfs/api/v1/cart/create`
// on opening, `PUT cfs/api/v1/cart` on each change after. The server's answer
// carries the account's userId, a cartId and the delivery address: so the cart
// looks like the account's. Blinkit's looked like that too, and belonged to a
// device (Appendix A). Only the phone can say.
//
//   npx tsx probe-cart.ts read      open the cart in the page and overhear the
//                                   page's own cart call (saved for replay)
//   npx tsx probe-cart.ts add       our own UNSIGNED call: the same cart plus one
//                                   cheap item from the household's buy-again list
//   npx tsx probe-cart.ts restore   our own call: the cart exactly as `read` saw it
//
// Never an order, never a payment. `add` changes the household's real cart,
// which `restore` puts back. Nothing secret is printed: product names, counts
// and totals only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const CDP = 'http://127.0.0.1:9336';
const ORIGIN = 'https://www.zepto.com';
const API = 'https://bff-gateway.zepto.com';
const DIR = join('runs', 'cart-probe'); // gitignored with runs/
const SAVED = join(DIR, 'page-cart-call.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CartCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  appVersion: string;
  answer: Record<string, unknown> | null;
}

type Line = { storeProductId: string; productVariantId: string; mrp: number; quantity: number; [k: string]: unknown };

async function openPage(): Promise<{ page: Page; appVersion: () => string; close: () => Promise<void> }> {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  let v = '';
  page.on('request', (r) => {
    const h = r.headers()['app_version'];
    if (h && r.url().startsWith(API)) v = h;
  });
  return { page, appVersion: () => v, close: async () => page.close() };
}

async function ourCall(page: Page, method: string, path: string, appVersion: string, body?: unknown) {
  const a = JSON.stringify({ url: API + path, method, body: body === undefined ? null : JSON.stringify(body), v: appVersion });
  return (await page.evaluate(`(async () => {
    const a = ${a};
    try {
      const r = await fetch(a.url, { method: a.method, credentials: 'include', body: a.body,
        headers: Object.assign({ app_version: a.v, appversion: a.v, auth_from_cookie: 'true' }, a.body ? { 'content-type': 'application/json' } : {}) });
      return { status: r.status, text: await r.text() };
    } catch (e) { return { status: -1, text: String(e) }; }
  })()`)) as { status: number; text: string };
}

// What the server says is in the cart: every line it answers with a variant
// and a quantity, wherever it keeps them.
function linesIn(answer: unknown): { name: string; variant: string; qty: number }[] {
  const out = new Map<string, { name: string; variant: string; qty: number }>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const r = o as Record<string, unknown>;
    const sp = (r.storeProduct ?? null) as Record<string, unknown> | null;
    const variant = (sp?.productVariant as { id?: string } | undefined)?.id ?? (typeof r.productVariantId === 'string' ? r.productVariantId : undefined);
    const name = (sp?.product as { name?: string } | undefined)?.name;
    if (variant && name && typeof r.quantity === 'number' && !out.has(variant)) out.set(variant, { name, variant, qty: r.quantity });
    Object.values(r).forEach(walk);
  };
  walk(answer);
  return [...out.values()];
}

function summary(label: string, answer: Record<string, unknown> | null) {
  if (!answer) return console.log(`${label}: no answer`);
  console.log(`${label}: cart ${String(answer.cartId).slice(0, 8)}…, ${answer.itemQuantityCount} units, ₹${Number(answer.grandTotalAmount) / 100} to pay, deliverable ${answer.isDeliverable}`);
  const top = ((answer.cartProducts ?? answer.products) as unknown) ?? answer;
  for (const l of linesIn(top)) console.log(`   ${l.qty} × ${l.name}`);
}

async function read() {
  const { page, appVersion, close } = await openPage();
  let call: CartCall | null = null;
  page.on('response', async (res) => {
    const req = res.request();
    const path = new URL(req.url()).pathname;
    if (!/\/cfs\/api\/v1\/cart(\/create)?$/.test(path) || !['POST', 'PUT'].includes(req.method())) return;
    try {
      call = { method: req.method(), path, body: JSON.parse(req.postData() ?? '{}'), appVersion: appVersion(), answer: JSON.parse(await res.text()) };
    } catch {
      /* not JSON */
    }
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await sleep(4000);
  const local = (await page.evaluate(`(() => { try { const c = JSON.parse(localStorage.getItem('cart') || '{}'); return Object.values(c.state?.cartContent || {}).map((x) => x.quantity + ' × ' + x.title); } catch (e) { return []; } })()`)) as string[];
  console.log(`the page's own copy (localStorage): ${local.length ? local.join(', ') : 'empty'}`);
  await page.goto(`${ORIGIN}/?cart=open`, { waitUntil: 'load' });
  await sleep(7000);
  if (!call) {
    console.log('the page made no cart call on opening the cart (an empty local cart may not ask the server)');
  } else {
    const c = call as CartCall;
    mkdirSync(DIR, { recursive: true });
    writeFileSync(SAVED, JSON.stringify(c, null, 2));
    console.log(`the page's own call: ${c.method} ${c.path}, ${(c.body.cartProducts as unknown[] | undefined)?.length ?? 0} lines sent`);
    summary("the server's answer", c.answer);
  }
  await close();
}

async function add() {
  const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as CartCall;
  const { page, appVersion, close } = await openPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await sleep(4000);
  const v = appVersion() || saved.appVersion;
  const storeId = String(saved.body.storeId);
  const again = await ourCall(page, 'GET', `/recommendation-service/api/v1/buy-again-products?store_id=${storeId}&group_id=All+Items`, v);
  const products = ((JSON.parse(again.text) as { storeProducts?: Record<string, unknown>[] }).storeProducts ?? []).filter(
    (p) => p.outOfStock === false && (p as { isCafe?: boolean }).isCafe !== true,
  );
  const wanted = new RegExp(process.env.ITEM ?? 'coriander|dhaniya', 'i');
  const pick =
    products.find((p) => wanted.test(String((p.product as { name?: string }).name))) ?? [...products].sort((a, b) => Number(a.sellingPrice) - Number(b.sellingPrice))[0];
  if (!pick) throw new Error('nothing in stock on the buy-again list');
  const variant = (pick.productVariant as { id: string }).id;
  const line: Line = { storeProductId: String(pick.id), productVariantId: variant, mrp: Number(pick.mrp), quantity: 1, isDiscountApplicable: true, isAddedToGiftBag: false };
  console.log(`adding 1 × ${(pick.product as { name: string }).name} (₹${Number(pick.sellingPrice) / 100})`);

  const body = structuredClone(saved.body);
  body.cartId = String(saved.answer?.cartId ?? body.cartId ?? '');
  body.cartProducts = [...((body.cartProducts as Line[]) ?? []), { ...line, actionType: '' }];
  body.cartProductsV2 = [...((body.cartProductsV2 as Line[]) ?? []), { ...line, actionType: '', cartProductId: randomUUID(), addOns: [] }];
  const r = await ourCall(page, 'PUT', '/cfs/api/v1/cart', v, body);
  console.log(`our unsigned PUT /cfs/api/v1/cart → ${r.status}`);
  let answer: Record<string, unknown> | null = null;
  try {
    answer = JSON.parse(r.text);
  } catch {
    console.log(`   not JSON: ${r.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  if (answer && r.status === 200) summary("the server's answer", answer);
  else if (answer) console.log(`   refused: ${JSON.stringify(answer).slice(0, 300)}`);
  await close();
}

async function restore() {
  const saved = JSON.parse(readFileSync(SAVED, 'utf8')) as CartCall;
  const { page, appVersion, close } = await openPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await sleep(4000);
  const body = { ...saved.body, cartId: String(saved.answer?.cartId ?? saved.body.cartId ?? '') };
  const r = await ourCall(page, 'PUT', '/cfs/api/v1/cart', appVersion() || saved.appVersion, body);
  console.log(`restore PUT → ${r.status}`);
  try {
    summary("the server's answer", JSON.parse(r.text));
  } catch {
    console.log(r.text.slice(0, 200));
  }
  await close();
}

const mode = process.argv[2];
(mode === 'read' ? read() : mode === 'add' ? add() : mode === 'restore' ? restore() : Promise.reject(new Error('usage: read | add | restore')))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[fail]', e instanceof Error ? e.message : e);
    process.exit(1);
  });
