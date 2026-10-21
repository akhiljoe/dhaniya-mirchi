// Paying for a Blinkit cart (design §19 stages 2-3, Appendix A).
//
// Payment is Zomato's, not Blinkit's: zpaykit on zomato.com holds the cards,
// Razorpay is the gateway, and the 3-D Secure page belongs to the bank. Only
// two calls in the whole chain are Blinkit's own.
//
// Everything exported here is a pure reader except the session methods, and
// the readers are where the care is: each one is written against a real
// captured answer, and each says null rather than guessing, because every
// number in this file is money.
//
// The one rule that shapes all of it: `zomato_payment_hash` mints a real
// order id and settles the price BEFORE anything is paid. So the household is
// shown that price and agrees to it, and only then is `makePayment` called.
// Nothing here calls makePayment on its own.
import type { Page } from 'playwright-core';

import {
  BLINKIT_ORIGIN,
  BLINKIT_PAYMENT_HASH_PATH,
  ZPAYKIT_MAKE_PAYMENT_PATH,
  ZPAYKIT_COUNTRY_ID,
  ZPAYKIT_DEFAULT_PAYMENT_PATH,
  ZPAYKIT_METHODS_PATH,
  ZPAYKIT_ORIGIN,
  ZPAYKIT_SERVICE_TYPE,
} from '../../constants.js';

// A way to pay that the household already has, described in the words their
// own screen uses. No card number exists here: the card is a vault token at
// the vendor, and that is all we ever hold.
export interface BlinkitPaymentMethod {
  methodId: string;
  // "card" for a saved card. Anything else is a wallet or a UPI handle, which
  // this code does not drive.
  methodType: string;
  // The vault token that stands in for the card. A secret: never logged,
  // never sent to a browser.
  cardToken: string | null;
  vault: string | null;
  // What the household's own screen calls it: "Amex American Express Card",
  // "****** 1111". Shown so they recognise what is about to be charged.
  label: string;
  lastFour: string;
  issuingBank: string;
  // How many digits this card's code has. Read, never assumed: this
  // household's preferred card is an Amex and wants FOUR. A four digit code
  // typed into a box validated for three is a decline on an order that
  // already has an id.
  cvvLength: number | null;
  // Whether the vendor wants a code for this card at all.
  cvvWanted: boolean;
  // The vendor's own verdict that this card can still be used
  // (`valid_for_payment`, `card_status`). A card the bank has killed is a
  // decline on an order that already exists.
  usable: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// The household's last-used way to pay, and everything needed to use it.
//
// This is the only call an ordinary payment needs: the card list
// (getPaymentMethods) is for offering a DIFFERENT card. Both carry the same
// per-card fields, so both are read by this.
export function readDefaultPayment(status: number, body: string): BlinkitPaymentMethod | null {
  if (status !== 200) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const preferred = (json as { response?: { user_preferred_payment?: unknown } })?.response?.user_preferred_payment;
  if (!preferred || typeof preferred !== 'object') return null;
  return readPaymentMethod(preferred as Record<string, unknown>);
}

// One method, from wherever it was listed.
//
// The shape is two levels, and the first version of this read only the top
// one, so every card came back with no token and no CVV length. What the
// household is SHOWN lives on the method (`payment_method_id`,
// `display_text`, `subtitle`); what is needed to PAY lives underneath it, in
// `default_payment_object.card`. The card list nests the same way, which is
// why this takes either and digs.
//
// What it deliberately does not read: `first_six_digits`. With
// `last_four_digits` that is ten digits of a fifteen digit card, and nothing
// here has any use for it (design §7.6 - line items, quantities and dates
// only).
export function readPaymentMethod(o: Record<string, unknown>): BlinkitPaymentMethod | null {
  const methodId = str(o.payment_method_id) || str((o as { card_id?: unknown }).card_id);
  if (!methodId) return null;
  const nested = (o.default_payment_object as { card?: unknown } | undefined)?.card;
  const card = (nested ?? (o as { card?: unknown }).card ?? o) as Record<string, unknown>;
  // `disable_cvv_page: 0` means a code IS wanted. The double negative is the
  // vendor's, and reading it backwards skips asking for a code the payment
  // then fails without.
  const disabled = num(card.disable_cvv_page);
  // The vendor's own two words for "this card can be used". Both must agree:
  // a card the household has left on the account but the bank has since
  // killed is a declined payment on an order that already has an id.
  const validFlag = num(card.valid_for_payment);
  const statusWord = str(card.card_status).toLowerCase();
  return {
    methodId,
    methodType: str(o.payment_method_type) || 'card',
    cardToken: typeof card.card_token === 'string' && card.card_token ? card.card_token : null,
    vault: typeof card.vault === 'string' && card.vault ? card.vault : null,
    label: str(o.display_text) || str(card.card_name),
    lastFour: str(card.last_four_digits) || str(o.subtitle).replace(/[^0-9]/g, '').slice(-4),
    issuingBank: str(card.issuing_bank),
    cvvLength: num(card.cvv_length),
    cvvWanted: disabled === null ? true : disabled === 0,
    usable: (validFlag === null || validFlag === 1) && (statusWord === '' || statusWord === 'active'),
  };
}

// What `zomato_payment_hash` settles: the price the gateway will be asked
// for, and the order id the vendor has already minted for it.
export interface BlinkitPaymentIntent {
  ok: boolean;
  // Minted before the money moves. Recorded the moment it is seen, so the app
  // can say "an order id exists" rather than "it failed" - the same rule
  // Instamart taught, for a vendor where the order does not yet appear.
  orderId: string | null;
  // The number to put in front of the household. Never our own sum of the
  // cart: the cart's bill is not what the checkout charges.
  payableAmount: number | null;
  cartId: string | null;
  // The hash the payment call needs. A secret, so only its presence is ever
  // reported; the value never leaves the worker.
  paymentHash: string | null;
}

export function readPaymentIntent(status: number, body: string): BlinkitPaymentIntent {
  const out: BlinkitPaymentIntent = { ok: false, orderId: null, payableAmount: null, cartId: null, paymentHash: null };
  if (status !== 200) return out;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return out;
  }
  const meta = (json as { zomato_payment_hash_meta?: unknown })?.zomato_payment_hash_meta;
  if (!meta || typeof meta !== 'object') return out;
  const m = meta as Record<string, unknown>;
  const orderId = str(m.order_id);
  return {
    ok: true,
    orderId: orderId || null,
    payableAmount: num(m.payable_amount),
    cartId: str(m.cart_id) || null,
    paymentHash: typeof m.payment_hash === 'string' && m.payment_hash ? m.payment_hash : null,
  };
}

// What `makePayment` answers. `pending` with `is_3d_secure_payment` is the
// normal case: the bank has not been asked yet, and the household's own phone
// is about to get a code.
export interface BlinkitPaymentStart {
  ok: boolean;
  status: string;
  gateway: string;
  needsBank: boolean;
  trackId: string | null;
  // Where the bank's page is reached through. Followed, never shown.
  checkoutUrl: string | null;
  message: string;
}

export function readPaymentStart(status: number, body: string): BlinkitPaymentStart {
  const out: BlinkitPaymentStart = { ok: false, status: '', gateway: '', needsBank: false, trackId: null, checkoutUrl: null, message: '' };
  if (status !== 200) return out;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return out;
  }
  const r = (json as { response?: unknown })?.response;
  if (!r || typeof r !== 'object') return out;
  const o = r as Record<string, unknown>;
  const tx = (o.transaction ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status: str(o.status) || str(tx.status),
    gateway: str(o.gateway_type),
    // The vendor sends "1", not true.
    needsBank: num(o.is_3d_secure_payment) === 1,
    trackId: str(tx.track_id) || null,
    checkoutUrl: str(tx.checkout_url) || null,
    message: str(o.message) || str(tx.message),
  };
}

// The form zpaykit wants. Its calls are multipart or form-urlencoded, never
// JSON, and a JSON body is simply not understood.
export function zpaykitForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

// What to ask `userDefaultPayment`. `amount` is the vendor's own figure for
// the cart, which it uses to decide which methods are even offered.
export function defaultPaymentFields(phone: string, amount: number): Record<string, string> {
  return {
    country_id: String(ZPAYKIT_COUNTRY_ID),
    service_type: ZPAYKIT_SERVICE_TYPE,
    phone,
    amount: String(amount),
    criteria: 'last_used_global',
    online_payments_flag: '1',
    apple_merchant_id: '',
  };
}

export const ZPAYKIT_CALLS = {
  defaultPayment: `${ZPAYKIT_ORIGIN}${ZPAYKIT_DEFAULT_PAYMENT_PATH}`,
  methods: `${ZPAYKIT_ORIGIN}${ZPAYKIT_METHODS_PATH}`,
  paymentHash: `${BLINKIT_ORIGIN}${BLINKIT_PAYMENT_HASH_PATH}`,
} as const;


// Driving zpaykit, which is on a different site from the cart.
//
// Two pages, and the split is not a convenience:
//
//   - the BLINKIT page makes `zomato_payment_hash`, because that is a Blinkit
//     endpoint and needs the Blinkit device headers;
//   - a ZOMATO page makes every zpaykit call, because zpaykit refuses a
//     blinkit.com origin at CORS - the fetch fails before it is sent. Loading
//     zomato.com is safe: a different origin cannot see, and cannot replace,
//     the Blinkit cart.
//
// What authorises zpaykit is `createOrder`'s `access_token`, carried as the
// `x-client-pas-token` header. Not a bearer, not a form field, not a query
// parameter: all three were tried against the live endpoint and answered
// "Empty Access token" (Appendix A).
export class BlinkitPaySession {
  constructor(
    private readonly blinkitCall: (path: string, method: 'GET' | 'POST', body?: unknown) => Promise<{ status: number; body: string }>,
    private readonly zomato: Page,
    // The short-lived token from createOrder. A secret: it is put in a header
    // and never anywhere else.
    private readonly accessToken: string,
  ) {}

  // A zpaykit call, from the zomato.com page, carrying the token.
  private async zpaykit(url: string, fields: Record<string, string>): Promise<{ status: number; body: string }> {
    const args = JSON.stringify({ url, body: zpaykitForm(fields), token: this.accessToken });
    return this.zomato.evaluate(`(async () => {
      const a = ${args};
      try {
        const r = await fetch(a.url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-client-pas-token': a.token },
          body: a.body,
        });
        return { status: r.status, body: await r.text() };
      } catch (err) {
        return { status: 0, body: String(err) };
      }
    })()`) as Promise<{ status: number; body: string }>;
  }

  // The card the household already uses. `amount` is the cart's own figure:
  // the vendor decides which methods it will even offer from it.
  async preferredCard(phone: string, amount: number): Promise<BlinkitPaymentMethod | null> {
    const r = await this.zpaykit(ZPAYKIT_CALLS.defaultPayment, defaultPaymentFields(phone, amount));
    return readDefaultPayment(r.status, r.body);
  }

  // Every saved card, for when the household wants a different one.
  async cards(phone: string, amount: number): Promise<BlinkitPaymentMethod[]> {
    const r = await this.zpaykit(ZPAYKIT_CALLS.methods, { ...defaultPaymentFields(phone, amount) });
    if (r.status !== 200) return [];
    let json: unknown;
    try {
      json = JSON.parse(r.body);
    } catch {
      return [];
    }
    // The list nests per category; the cards are walked for rather than
    // indexed, the same way the cart's items are.
    const out: BlinkitPaymentMethod[] = [];
    const seen = new Set<string>();
    const stack: unknown[] = [json];
    while (stack.length) {
      const v = stack.pop();
      if (Array.isArray(v)) {
        stack.push(...v);
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      if (typeof o.card_token === 'string' && o.card_token) {
        const card = readPaymentMethod(o);
        if (card && !seen.has(card.methodId)) {
          seen.add(card.methodId);
          out.push(card);
        }
      }
      stack.push(...Object.values(o));
    }
    return out;
  }

  // Spend the money.
  //
  // The only call in this file that costs anything. It is deliberately dumb:
  // it takes a form the caller has already built and sends it, so that every
  // decision about WHAT is paid - which card, which hash, which amount, and
  // whether the household agreed to it - is made and checked elsewhere,
  // where it can be tested.
  async makePayment(form: string): Promise<{ status: number; body: string }> {
    const args = JSON.stringify({ url: `${ZPAYKIT_ORIGIN}${ZPAYKIT_MAKE_PAYMENT_PATH}`, body: form, token: this.accessToken });
    return this.zomato.evaluate(`(async () => {
      const a = ${args};
      try {
        const r = await fetch(a.url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-client-pas-token': a.token },
          body: a.body,
        });
        return { status: r.status, body: await r.text() };
      } catch (err) {
        return { status: 0, body: String(err) };
      }
    })()`) as Promise<{ status: number; body: string }>;
  }

  // Settle the price and mint the order id.
  //
  // This is the last call before money, and the one the household's agreement
  // is taken against: it answers with the amount the gateway will actually be
  // asked for, which is not the cart's own bill. Nothing is paid here, but an
  // order id exists from this point on and must be recorded by the caller
  // whatever happens next.
  async settle(cartId: number | string, method: BlinkitPaymentMethod): Promise<BlinkitPaymentIntent> {
    const r = await this.blinkitCall(BLINKIT_PAYMENT_HASH_PATH, 'POST', {
      cart_id: String(cartId),
      payment_info_data: { payment_method_id: method.methodId, payment_method_type: method.methodType },
    });
    return readPaymentIntent(r.status, r.body);
  }
}


// Did the order we paid for actually get placed?
//
// The verdict never comes from the call that placed it (design §19): that
// call answers before the money moves, so reading it back says nothing. The
// vendor's own order list is asked instead - and the thing to match on is NOT
// the payment's order id.
//
// Measured on 2026-09-23, against a payment that went through: the payment's
// `order_id` was 1000000002, an earlier cancelled attempt's was 1000000001,
// and the order that appeared in the history is 1000000003. Three different
// numbers. What ties them together is the CART: the history stub's identity
// reads `order_<orderId>_<cartId>`, and the cart id is 3900000001, which is
// the cart both attempts were for and the one id we have held all along.
//
// So the cart id is the link, and matching on the payment's order id - which
// is what §19's rule said in general - would never match anything here.
export interface BlinkitOrderSighting {
  // The vendor's own id for the order, which is not the payment's.
  orderId: string;
  // The vendor's word: DELIVERED, ENROUTE, and whatever else it uses. Passed
  // through rather than mapped, because a word we have not seen is not a
  // word to guess at.
  status: string;
  total: number | null;
}

// `stubs` is what stubsFromList already returns, so this adds no parsing of
// its own and inherits the tests that shape has.
export function findOrderForCart(
  stubs: { orderId: string; cartId: string; status: string; total: number | null }[],
  cartId: string | number,
): BlinkitOrderSighting | null {
  const want = String(cartId);
  const hit = stubs.find((s) => s.cartId === want);
  return hit ? { orderId: hit.orderId, status: hit.status, total: hit.total } : null;
}

// What the app is allowed to say about a payment afterwards.
//
// `placed` only when the vendor's own list shows the order. `unconfirmed` for
// everything else - never "failed". Telling a household a payment failed when
// it did not is how they pay twice, and a just-paid order takes some minutes
// to become a row in that list: it is a tracking card first. So the honest
// answer in that window is "we could not tell yet", and the caller asks
// again rather than deciding.
export type BlinkitVerdict = { state: 'placed'; order: BlinkitOrderSighting } | { state: 'unconfirmed' };

export function verdictForCart(
  stubs: { orderId: string; cartId: string; status: string; total: number | null }[],
  cartId: string | number,
): BlinkitVerdict {
  const order = findOrderForCart(stubs, cartId);
  return order ? { state: 'placed', order } : { state: 'unconfirmed' };
}
