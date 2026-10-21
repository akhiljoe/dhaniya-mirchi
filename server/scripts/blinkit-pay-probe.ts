// Does Blinkit's gateway accept our payment call without a CVV?
//
//   cd server
//   npx tsx --env-file=../.env scripts/blinkit-pay-probe.ts
//
// This is the one question left before Blinkit payment can be turned on. The
// household watched themselves pay and typed a CVV into the vendor's own page,
// but no request in the whole recorded checkout carries one - so either the
// gateway does not need it from us, or it goes somewhere we have not found.
//
// WHAT IT DOES: fills a cart with one cheap item, settles the price, calls
// makePayment with no CVV, and follows the answer as far as the bank's own
// page. Then it stops and empties the cart.
//
// WHAT IT DOES NOT DO: type a code. No OTP is entered, so no money moves. The
// household did exactly this twice by hand and the order list was unchanged
// both times (design Appendix A). `zomato_payment_hash` does mint a real order
// id before any money moves, so that id is printed: if anything ever does look
// wrong, that is the number to look for in the app.
//
// It needs CHROME_PATH and CHROME_VERSION on Windows (see .env.example).
import { loadConfig } from '../src/config.js';
import { PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS, ZPAYKIT_ORIGIN } from '../src/constants.js';
import { createDb } from '../src/db.js';
import { openSealed } from '../src/vault.js';
import { blinkitCartAdapter } from '../src/worker/adapters/blinkit-cart.js';
import { BlinkitPaySession, readPaymentStart, zpaykitForm } from '../src/worker/adapters/blinkit-pay.js';
import { phoneFromStorage } from '../src/worker/adapters/blinkit-cart-session.js';
import { readStoredAddresses } from '../src/worker/adapters/blinkit.js';
import { launchHeadless } from '../src/worker/chrome.js';
import type { CapturedSession } from '../src/worker/connect.js';
import type { Page } from 'playwright-core';

const PHONE_LAST4 = process.env.PROBE_PHONE_LAST4 ?? '4567';
const ADDRESS_ID = process.env.PROBE_ADDRESS_ID ?? '100000001';
const SEARCH = process.env.PROBE_ITEM ?? 'Amul Taaza milk';

const e = process.env;
const dbUrl = `postgres://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? '5435'}/${e.POSTGRES_DB}`;
const db = createDb(dbUrl);
const config = loadConfig({ ...e, DATABASE_URL: dbUrl } as Record<string, string>);
const { rows } = await db.query<{ id: string; session_sealed: string; addresses: unknown }>(
  "select id, session_sealed, addresses from vendor_connections where vendor = 'blinkit' and phone_last4 = $1",
  [PHONE_LAST4],
);
if (!rows.length) throw new Error(`no Blinkit connection ending ${PHONE_LAST4}`);
const addresses = readStoredAddresses(JSON.stringify({ addresses_data: rows[0].addresses }));
const home = addresses.find((a) => String(a.id) === ADDRESS_ID);
if (!home) throw new Error(`address ${ADDRESS_ID} is not saved on that account`);
const session = JSON.parse(
  openSealed(config.vault.privateKeys, rows[0].session_sealed, `vendor_connections:${rows[0].id}:session`),
) as CapturedSession;

const s = await blinkitCartAdapter(() => launchHeadless(e.CHROME_PATH, e.CHROME_VERSION)).open(session, home);
const page = (s as unknown as { page: Page }).page;
const call = (s as unknown as {
  call(p: string, m: 'GET' | 'POST' | 'PUT', b?: unknown): Promise<{ status: number; body: string }>;
}).call.bind(s);

let orderId: string | null = null;
try {
  const found = await s.search(SEARCH);
  if (!found.length) throw new Error(`this store sells nothing called "${SEARCH}"`);
  const item = found.reduce((a, b) => (b.price < a.price ? b : a));
  const filled = await s.fill([{ item, quantity: 1 }]);
  await s.validate(filled.cartId!, [{ item, quantity: 1 }]);
  console.log(`cart     : ${filled.cartId} | ${item.product_name} ${item.unit} | cart says Rs ${filled.total}`);

  const token = await s.createOrder(filled.cartId!);
  if (!token.paymentToken) throw new Error('createOrder gave no access token');
  const phone = phoneFromStorage((await page.evaluate(`localStorage.getItem('auth')`)) as string | null);
  if (!phone) throw new Error('no phone number on the page; zpaykit needs one');

  const zomato = await page.context().newPage();
  await zomato.goto(`${ZPAYKIT_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
  await zomato.waitForTimeout(PAGE_SETTLE_MS);
  const pay = new BlinkitPaySession(call, zomato, token.paymentToken);

  const card = await pay.preferredCard(phone, filled.total ?? 0);
  if (!card) throw new Error('zpaykit named no card for this account');
  console.log(`card     : ${card.label} ${card.lastFour} | vendor wants a CVV: ${card.cvvWanted} (${card.cvvLength} digits)`);

  const intent = await pay.settle(filled.cartId!, card);
  orderId = intent.orderId;
  console.log(`settled  : order ${intent.orderId} | gateway wants Rs ${intent.payableAmount} | hash ${intent.paymentHash ? 'present' : 'MISSING'}`);
  if (!intent.ok || !intent.paymentHash || intent.payableAmount === null) throw new Error('the settle did not answer with a price');

  // The whole question: no CVV field anywhere in this.
  const r = await pay.makePayment(
    zpaykitForm({
      payment_method_id: card.methodId,
      payment_method_type: card.methodType,
      card_token: card.cardToken ?? '',
      card_vault: card.vault ?? '',
      service_type: 'BLINKIT',
      order_type: 'BLINKIT',
      country_id: '1',
      order_id: intent.orderId ?? '',
      amount: String(intent.payableAmount),
      host_redirect_url: 'https://blinkit.com/',
      payments_hash: intent.paymentHash,
      phone,
      email: '',
    }),
  );
  const started = readPaymentStart(r.status, r.body);
  console.log(
    `payment  : http ${r.status} | ok ${started.ok} | status "${started.status}" | gateway "${started.gateway}" | bank needed ${started.needsBank}`,
  );
  if (!started.ok) console.log(`  refused: ${r.body.slice(0, 300)}`);

  if (started.checkoutUrl) {
    await zomato.goto(started.checkoutUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS }).catch(() => undefined);
    await zomato.waitForTimeout(PAGE_SETTLE_MS * 2);
    const text = (await zomato.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`bank host: ${new URL(zomato.url()).hostname}`);
    console.log(`bank page: ${text.slice(0, 200) || '(nothing readable)'}`);
    console.log(
      text.toLowerCase().includes('cvv')
        ? '\nVERDICT  : the bank page is asking for a CVV, so it has to come from us.'
        : '\nVERDICT  : reached the bank without sending a CVV. The gateway did not need one from us.',
    );
  } else {
    console.log('\nVERDICT  : no bank page was offered. Read the refusal above.');
  }
  console.log('\nSTOPPED. No code was typed and no money moved.');
} finally {
  if (orderId) console.log(`\nIf anything ever looks wrong, the order id minted here was ${orderId}.`);
  await s.empty().then((x) => console.log('cart emptied:', x.ok)).catch(() => console.log('cart could NOT be emptied'));
  await s.close();
  await db.end();
}
