// Blinkit's cart, and the road to an order (design §19, Appendix A).
//
// Blinkit is not Instamart and almost nothing carries over:
//
//   - our own fetch is accepted, so there are no buttons to drive;
//   - `POST /v5/carts` REPLACES the cart. There is no read-only look: an
//     empty list is not a question, it is an instruction to empty. So the
//     whole wanted list is posted once, and nothing here ever asks first;
//   - a cart belongs to a `device_id`, not to an account, so the cart this
//     fills is the worker's own and the household's phone can never see it.
//     That is only bearable because we pay for it ourselves - for a cart the
//     household has to open, Blinkit stays read-only;
//   - the store follows the `lat`/`lon` of the session, not the account. A
//     restored session carries the vendor's Gurugram default, so without the
//     step below every cart is filled a thousand kilometres from the
//     household, at a store with a different catalogue.
//
// The chain to an order, recorded end to end on 2026-09-22 (Appendix A):
//   PUT/POST /v5/carts -> POST /v5/carts/{id}/validate -> GET /createOrder/{id}
//   -> POST /zomato_payment_hash -> zpaykit makePayment -> Razorpay 3-D Secure.
// Everything in this file stops before the payment hash: nothing here can
// move money.
import type { Page } from 'playwright-core';

import {
  BLINKIT_CARTS_PATH,
  BLINKIT_CREATE_ORDER_PATH,
  BLINKIT_ORIGIN,
  BLINKIT_SEARCH_PATH,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
} from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import type { CapturedSession } from '../connect.js';
import type { VendorAddress } from './instamart-catalog.js';

// What a product card hands over about itself. The vendor's own description
// of what to add, used verbatim rather than rebuilt from parts.
export interface BlinkitCartItem {
  product_id: number;
  merchant_id: number;
  product_name: string;
  quantity: number;
  price: number;
  unit: string;
  [k: string]: unknown;
}

// Every `atc_action.add_to_cart.cart_item` anywhere in a search answer. The
// shape nests differently per widget, so this walks rather than indexes.
export function addToCartItems(json: unknown): BlinkitCartItem[] {
  const out: BlinkitCartItem[] = [];
  const stack: unknown[] = [json];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const atc = o.atc_action as { add_to_cart?: { cart_item?: BlinkitCartItem } } | undefined;
      const item = atc?.add_to_cart?.cart_item;
      if (item && typeof item.product_id === 'number') out.push(item);
      stack.push(...Object.values(o));
    }
  }
  return out;
}

// Which store the session is pointed at. `merchant` is written by the page
// once it has resolved the coordinates; before that it is whatever the last
// session left behind.
export function readMerchantId(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { id?: unknown })?.id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

// The localStorage the page should wake up with: the household's own
// coordinates, and no stale merchant to short-circuit resolving them.
//
// `isDefault: false` is the point of the exercise. A restored session says
// `isDefault: true` with the vendor's Gurugram coordinates, and the page
// believes it.
export function locationFor(address: VendorAddress): string {
  return JSON.stringify({
    coords: {
      isDefault: false,
      lat: address.lat,
      lon: address.lng,
      locality: address.label || '',
      addressId: Number(address.id),
      landmark: null,
    },
  });
}

export class BlinkitCartSession {
  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
    private readonly headers: () => Record<string, string>,
    readonly address: VendorAddress,
  ) {}

  // The store the session resolved to, once the page has settled. Read back
  // rather than assumed: the coordinates are a request, the merchant is the
  // vendor's answer.
  async store(): Promise<{ merchantId: number | null; lat: number; lng: number }> {
    const raw = (await this.page.evaluate(`localStorage.getItem('merchant')`)) as string | null;
    return { merchantId: readMerchantId(raw), lat: this.address.lat, lng: this.address.lng };
  }

  private async call(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<{ status: number; body: string }> {
    const args = JSON.stringify({
      path,
      method,
      body: body === undefined ? null : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...this.headers() },
    });
    return this.page.evaluate(`(async () => {
      const a = ${args};
      const r = await fetch(a.path, { method: a.method, credentials: 'include', headers: a.headers, body: a.body });
      return { status: r.status, body: await r.text() };
    })()`) as Promise<{ status: number; body: string }>;
  }

  // What this store sells under a name. Read-only: search writes nothing.
  async search(query: string): Promise<BlinkitCartItem[]> {
    const r = await this.call(`${BLINKIT_SEARCH_PATH}?q=${encodeURIComponent(query)}`, 'POST', { q: query });
    if (r.status !== 200) return [];
    try {
      return addToCartItems(JSON.parse(r.body)).filter((i) => Number(i.inventory ?? 1) > 0);
    } catch {
      return [];
    }
  }

  // The whole wanted list, in one post.
  //
  // This is not "add": `/v5/carts` replaces what is there, so the caller
  // hands over everything it wants and gets back what the vendor says is in
  // the cart afterwards. Emptying is the same call with an empty list, which
  // is why nothing here can ask what is in the cart first - the asking would
  // be the emptying.
  //
  // Only `product_id` and `quantity` go up. The search result's `cart_item`
  // is the right way to IDENTIFY a product, but posting it back whole is a
  // 422: it carries `inventory`, `unavailable_quantity`, `meta` and
  // `eta_identifier`, which are the store's words about the product, not the
  // household's about their cart. Measured against the real account - five
  // shapes tried, this is the one the vendor accepts.
  async fill(items: { item: BlinkitCartItem; quantity: number }[]): Promise<BlinkitCartState> {
    const body = {
      items: items.map(({ item, quantity }) => ({ product_id: item.product_id, quantity })),
      promo_codes: [''],
    };
    const r = await this.call(BLINKIT_CARTS_PATH, 'POST', body);
    return readCartState(r.status, r.body);
  }

  // Put the cart back to empty.
  //
  // Named, rather than left to callers as "fill with nothing", because on
  // this vendor that is the only way to ask - and because a caller reaching
  // for the raw call to do it is a caller one typo away from replacing the
  // household's cart with an empty one by accident.
  async empty(): Promise<BlinkitCartState> {
    return this.fill([]);
  }

  // What the store says about this cart for this address: the bill, whether
  // it will deliver, and - the reason this is not optional - which address
  // the cart is actually bound to.
  //
  // `channel_address_id` is the `id` from GET /v4/address. The answer echoes
  // back `cart_data.address.id`, and the caller is expected to check it
  // matches: on this vendor the store follows the coordinates, so a cart
  // bound to the wrong address is a cart filled at a store in another city.
  async validate(cartId: number, items: { item: BlinkitCartItem; quantity: number }[]): Promise<BlinkitValidation> {
    const r = await this.call(`${BLINKIT_CARTS_PATH}/${cartId}/validate`, 'POST', {
      channel_address_id: Number(this.address.id),
      items: items.map(({ item, quantity }) => ({ product_id: String(item.product_id), quantity })),
      promo_codes: [''],
    });
    return readValidation(r.status, r.body);
  }

  // The last step before anything to do with money. Hands back a short-lived
  // token and an order hash; it does NOT place an order - measured twice on
  // the real account, where cancelling after this left the order list
  // untouched (Appendix A). Unlike Instamart, where the order exists before
  // the money does, nothing has been created here yet.
  //
  // The token it returns is a payment credential. It is handled like every
  // other vendor token: never logged, never put in an error, never sent to a
  // browser.
  async createOrder(cartId: number): Promise<BlinkitOrderToken> {
    const r = await this.call(`${BLINKIT_CREATE_ORDER_PATH}/${cartId}`, 'GET');
    return readOrderToken(r.status, r.body);
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

// What the vendor says is in the cart, after a fill.
//
// Read from `cart_data`, at the two places that actually hold it: `items` is
// the line list and `bill_details` the money. Nothing here walks the whole
// answer looking for a shape. The first version did, and reported six lines
// for one item, because a product is echoed back inside several widgets and
// `total` appears in none of them - the bill calls it `payable_amount`.
//
// Every field is the vendor's own number. A missing one is null, never a sum
// of our own: the bill is what the household will be charged, and the one
// thing here that must never be inferred.
export interface BlinkitCartState {
  ok: boolean;
  cartId: number | null;
  lines: BlinkitCartLine[];
  // What the vendor will charge: items, plus delivery, plus whatever else it
  // has decided to add. `subtotal` is the items alone, and the two differ by
  // more than the delivery fee - a 34 rupee cart was payable at 107, because
  // of a 43 rupee `additional_charge` neither we nor the cart page spell out.
  // Same lesson as Instamart (design §19 stage 2): show the vendor's own
  // number, never a total of ours.
  total: number | null;
  subtotal: number | null;
  deliveryFee: number | null;
  // Spend above this and the vendor drops the delivery fee
  // (`free_delivery_mov`, 250 on this account).
  freeDeliveryAbove: number | null;
  // Everything the vendor adds that is not items or delivery, as one number:
  // handling, late-night convenience, small-cart, the donation. Its own cart
  // page itemises them; its cart call gives only this sum. Shown, because a
  // bill of 10 + 30 that comes to 98 is a bill nobody should be asked to
  // agree to without the missing line.
  additionalCharge: number | null;
  // Units the store cannot supply, counted by the vendor. Units, not lines: a
  // line of quantity 2 with none in stock counts 2 here.
  unavailableUnits: number | null;
}

export interface BlinkitCartLine {
  productId: number;
  name: string;
  quantity: number;
  // Per unit, as the vendor prices it today.
  price: number | null;
  unit: string;
  // How many of `quantity` the store cannot supply. Above zero is the "not
  // available" the household is shown.
  unavailableQuantity: number;
}

const EMPTY: BlinkitCartState = {
  ok: false,
  cartId: null,
  lines: [],
  total: null,
  subtotal: null,
  deliveryFee: null,
  freeDeliveryAbove: null,
  additionalCharge: null,
  unavailableUnits: null,
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function readCartState(status: number, body: string): BlinkitCartState {
  if (status !== 200) return { ...EMPTY };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ...EMPTY };
  }
  const cart = (json as { cart_data?: unknown })?.cart_data;
  if (!cart || typeof cart !== 'object') return { ...EMPTY };
  const c = cart as Record<string, unknown>;
  const bill = (c.bill_details ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(c.items) ? (c.items as Record<string, unknown>[]) : [];
  const lines: BlinkitCartLine[] = [];
  for (const o of rows) {
    const productId = num(o.product_id);
    const quantity = num(o.quantity);
    if (productId === null || quantity === null || quantity <= 0) continue;
    lines.push({
      productId,
      name: typeof o.name === 'string' ? o.name : '',
      quantity,
      price: num(o.price),
      unit: typeof o.unit === 'string' ? o.unit : '',
      unavailableQuantity: num(o.unavailable_quantity) ?? 0,
    });
  }
  return {
    ok: true,
    cartId: num(c.id),
    lines,
    total: num(bill.payable_amount),
    subtotal: num(bill.total_cost),
    deliveryFee: num(bill.delivery_charge),
    freeDeliveryAbove: num(bill.free_delivery_mov),
    additionalCharge: num(bill.additional_charge),
    unavailableUnits: num(bill.unavailable_items),
  };
}

// What `validate` says. The bill comes from the same `cart_data` a fill
// returns, so it is read by the same function.
export interface BlinkitValidation {
  ok: boolean;
  cartId: number | null;
  // The address the vendor says this cart belongs to. Checked against the one
  // we asked for: a mismatch means the cart is being filled somewhere else.
  addressId: number | null;
  // Whether the store will deliver here at all. null is "it did not say",
  // which is not the same as no - and must not be read as yes either.
  serviceable: boolean | null;
  cart: BlinkitCartState;
}

export function readValidation(status: number, body: string): BlinkitValidation {
  const cart = readCartState(status, body);
  const out: BlinkitValidation = { ok: status === 200, cartId: null, addressId: null, serviceable: null, cart };
  if (status !== 200) return { ...out, ok: false };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { ...out, ok: false };
  }
  out.cartId = num(json.cart_id) ?? cart.cartId;
  const data = (json.cart_data ?? {}) as Record<string, unknown>;
  out.addressId = num((data.address as { id?: unknown } | undefined)?.id);
  // One entry per merchant this cart is split across. Serviceable only when
  // every one of them says so: a cart half of which cannot be delivered is
  // not a cart that can be delivered.
  const status_ = data.merchant_status;
  if (Array.isArray(status_) && status_.length) {
    const flags = status_.map((m) => (m as { is_serviceable?: unknown }).is_serviceable);
    if (flags.every((f) => typeof f === 'boolean')) out.serviceable = flags.every((f) => f === true);
  }
  return out;
}

// What `createOrder` hands back: a hash for the payment call, and a token to
// make it with. Nothing here is an order yet.
export interface BlinkitOrderToken {
  ok: boolean;
  orderHash: string | null;
  // A payment credential. Treated as a secret: it is never logged and never
  // leaves the worker.
  paymentToken: string | null;
  expiresAtEpoch: number | null;
  // True if the vendor put an order id in this answer after all. It never has
  // - but if that ever changes, an order exists before the money does, and
  // every rule Instamart taught us applies here too. Worth knowing loudly.
  orderId: string | null;
}

export function readOrderToken(status: number, body: string): BlinkitOrderToken {
  const out: BlinkitOrderToken = { ok: status === 200, orderHash: null, paymentToken: null, expiresAtEpoch: null, orderId: null };
  if (status !== 200) return { ...out, ok: false };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { ...out, ok: false };
  }
  if (typeof json.orderHash === 'string') out.orderHash = json.orderHash;
  const response = (json.response ?? {}) as Record<string, unknown>;
  if (typeof response.access_token === 'string') out.paymentToken = response.access_token;
  out.expiresAtEpoch = num(response.expiry_time_in_epoch);
  for (const key of ['order_id', 'orderId']) {
    const v = json[key] ?? response[key];
    if (typeof v === 'string' || typeof v === 'number') out.orderId = String(v);
  }
  return out;
}

export function blinkitCartAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    // `address` is the one the household picked. It is required, and there is
    // no default on purpose: of this household's 39 saved addresses, 20 are in
    // another city and several of the rest are friends' flats or an office.
    // On this vendor the address also chooses the STORE, so a guess is not a
    // parcel at the wrong door - it is a cart filled from a shop that cannot
    // deliver it.
    async open(session: CapturedSession, address: VendorAddress): Promise<BlinkitCartSession> {
      const hb = await launch();
      try {
        const context = hb.browser.contexts()[0];
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
        // The session's own storage, then the household's coordinates over
        // the top of it, and the stale merchant removed so the page has to
        // resolve them again.
        await context.addInitScript(
          `if (location.origin === ${JSON.stringify(BLINKIT_ORIGIN)}) {
             const s = ${JSON.stringify(session.localStorage)};
             for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
             localStorage.setItem('location', ${JSON.stringify(locationFor(address))});
             localStorage.removeItem('merchant');
           }`,
        );
        const page = await context.newPage();
        // The device headers are read off the page's own calls, never
        // invented. The cart calls need `access_token` as well, which only
        // some of them carry.
        let headers: Record<string, string> = {};
        page.on('request', (req) => {
          const h = req.headers();
          if (!req.url().startsWith(BLINKIT_ORIGIN)) return;
          if (h.auth_key && h.device_id && h.access_token) headers = h;
        });
        await page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        await page.waitForTimeout(PAGE_SETTLE_MS);
        return new BlinkitCartSession(hb, page, () => headers, address);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}

// Named so a reader of the chain knows where this file deliberately stops.
export const BLINKIT_STOPS_BEFORE = `${BLINKIT_CARTS_PATH} -> validate -> ${BLINKIT_CREATE_ORDER_PATH}; payment is not here`;
