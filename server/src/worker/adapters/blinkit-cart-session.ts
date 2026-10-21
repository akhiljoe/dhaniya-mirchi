// Blinkit as a cart the app can fill and pay for (design §19 stages 1-3).
//
// This is the piece that lets `cart.ts` and `pay.ts` treat Blinkit like any
// other vendor. Underneath, almost nothing is the same, and two differences
// shape the whole file.
//
// **The cart replaces, it does not add.** `POST /v5/carts` takes the whole
// list and makes the cart be that. There is no "add one thing", and no
// read-only look either - `GET` on the same path is a 405, so asking what is
// in the cart IS replacing it. So this session remembers what it has been
// asked for and posts the entire list again on every `set`. That means the
// wanted list lives here, in memory, for the life of one job: it cannot be
// recovered from the vendor, because the vendor will only tell us by being
// overwritten.
//
// **The cart is the worker's own, and the household cannot see it.** A
// Blinkit cart belongs to a `device_id`, not to an account (Appendix A,
// confirmed from the household's own two devices). So nothing here is a cart
// anyone will open in the Blinkit app. That is only acceptable because we pay
// for it ourselves, in the same job, and because the order that results DOES
// appear in the household's own order list afterwards.
import type { Page } from 'playwright-core';

import { BLINKIT_ORIGIN, PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS, ZPAYKIT_ORIGIN } from '../../constants.js';
import type { CapturedSession } from '../connect.js';
import type { HeadlessBrowser } from '../chrome.js';
import { launchHeadless } from '../chrome.js';
import type { Checkout } from './checkout.js';
import { BlinkitCheckout } from './blinkit-checkout.js';
import { blinkitCartAdapter, type BlinkitCartItem, type BlinkitCartSession as RawCart } from './blinkit-cart.js';
import { BlinkitPaySession } from './blinkit-pay.js';
import { CartError, type CartLineResult, type CartSession, type CartWant, type PaymentOption } from './instamart-cart.js';
import type { CartState, VendorAddress } from './instamart-catalog.js';
import { readStoredAddresses } from './blinkit.js';
import { matchesWanted } from './blinkit-page.js';

// The account's own phone number, which zpaykit insists on.
//
// It is not ours to store: only the last four digits are kept, on purpose
// (design §7.6), so the full number has to come from the account itself. The
// page keeps it in its own `auth` entry, which is where the vendor's own
// client reads it from too.
export function phoneFromStorage(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/[6-9]\d{9}/);
  return m ? m[0] : null;
}

// Which of the store's search results is the thing the household buys.
//
// The first version took the cheapest result, and for "Bread" that was a ten
// rupee pineapple sweet-fill bread roll. Adding whatever is cheapest under a
// word is adding blind, which the cart rules forbid: `want.product` is the
// vendor's own name for the product this household actually buys, read from
// their orders, and that is what has to be in the cart.
//
// So: every significant word of the wanted name must appear in the result's
// name. Among those, the household's pack size is preferred, and the cheapest
// is taken only as a tie-break. Nothing matching means NOT LISTED - the
// household is told, rather than handed something else. Only a `search` want
// (a recipe's new ingredient, never bought before) takes the cheapest thing in
// stock, because there is no product of theirs to match.
const STOP_WORDS = new Set(['and', 'the', 'with', 'for', 'of', 'in', 'a', 'an', 'pack', 'combo']);

// A quantity written into a name - "400g", "1l", "500 ml", "2kg", "6pcs" -
// describes the pack, not the product, and the pack is matched on its own
// below. Requiring it as a word made "english oven sandwich bread 400g" fail
// to find "English Oven Sandwich Bread".
const PACK_WORD = /^\d+(\.\d+)?(g|gm|gms|kg|ml|l|ltr|litre|pc|pcs|pieces?|x\d+)?$/;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%. ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !PACK_WORD.test(w));
}

function samePack(a: string, b: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, '').replace(/ltr|litre|liter/g, 'l').replace(/gm|gms|gram|grams/g, 'g');
  return !!a && !!b && norm(a) === norm(b);
}

export function pickBlinkitProduct(
  found: BlinkitCartItem[],
  want: { product: string; pack: string; match?: 'exact' | 'search' },
): BlinkitCartItem | null {
  if (!found.length) return null;
  const cheapest = (xs: BlinkitCartItem[]) => xs.reduce((a, b) => (b.price < a.price ? b : a));
  if (want.match === 'search' || !want.product.trim()) return cheapest(found);

  if (!words(want.product).length) return cheapest(found);
  const matching = found.filter((f) => matchesWanted(f.product_name, want.product));
  if (!matching.length) return null;
  const inPack = matching.filter((f) => samePack(f.unit, want.pack));
  return cheapest(inPack.length ? inPack : matching);
}

export class BlinkitCartSession implements CartSession {
  address: VendorAddress | null;
  // What this job has asked for, in the order it asked. The cart is made to
  // be exactly this on every change, because that is the only way this vendor
  // accepts a cart at all.
  private readonly wanted: { item: BlinkitCartItem; quantity: number; want: CartWant }[] = [];
  private checkoutSession: Checkout | null = null;
  private zomato: Page | null = null;

  constructor(
    private readonly raw: RawCart,
    private readonly page: Page,
    address: VendorAddress,
  ) {
    this.address = address;
  }

  async addresses(): Promise<VendorAddress[]> {
    try {
      const stored = (await this.page.evaluate(`localStorage.getItem('addressesV2')`)) as string | null;
      return readStoredAddresses(stored ?? undefined);
    } catch {
      return [];
    }
  }

  // The address is chosen when the session is opened, because on this vendor
  // it also chooses the STORE: the coordinates decide which shop the cart is
  // filled from. Changing it afterwards would mean reopening the browser at
  // the new coordinates, so this says no rather than pretending.
  async useAddress(address: VendorAddress): Promise<boolean> {
    return String(address.id) === String(this.address?.id);
  }

  // What the vendor says is in the cart right now.
  //
  // Reposting the same list is how this is asked, because there is no
  // read-only look. With nothing wanted yet, nothing is posted at all: an
  // empty post is an instruction to empty the cart, not a question.
  async state(): Promise<CartState> {
    if (!this.wanted.length) {
      return { lines: [], bill: EMPTY_BILL, serving: true, eta: null, message: null, statuses: [] };
    }
    const filled = await this.raw.fill(this.wanted.map(({ item, quantity }) => ({ item, quantity })));
    return toCartState(filled);
  }

  async set(want: CartWant): Promise<CartLineResult> {
    const found = await this.raw.search(want.product || want.item);
    // The household's own product, or nothing. Never "the cheapest thing
    // under that word": that put a pineapple bread roll in a cart that asked
    // for bread.
    const item = pickBlinkitProduct(found, want);
    if (!item) {
      return { item: want.item, product: want.product, pack: want.pack, wanted: want.qty, inCart: 0, state: 'not_listed', price: null, note: null };
    }

    const at = this.wanted.findIndex((w) => w.item.product_id === item.product_id);
    if (want.qty <= 0) {
      if (at >= 0) this.wanted.splice(at, 1);
    } else if (at >= 0) {
      this.wanted[at].quantity = want.qty;
    } else {
      this.wanted.push({ item, quantity: want.qty, want });
    }

    const filled = await this.raw.fill(this.wanted.map(({ item: i, quantity }) => ({ item: i, quantity })));
    const line = filled.lines.find((l) => l.productId === item.product_id);
    return {
      item: want.item,
      product: item.product_name,
      pack: item.unit || want.pack,
      wanted: want.qty,
      inCart: line?.quantity ?? 0,
      state: !filled.ok ? 'failed' : line ? 'added' : 'out_of_stock',
      price: line?.price ?? item.price ?? null,
      note: line && line.unavailableQuantity > 0 ? `${line.unavailableQuantity} not available` : null,
    };
  }

  // What this account can pay with. A saved card needs its bank's OTP, so
  // nothing here can be ordered with nobody present.
  async paymentOptions(): Promise<PaymentOption[]> {
    const checkout = await this.openCheckout();
    if (!checkout) return [];
    const screen = await checkout.open().catch(() => null);
    return (screen?.cards ?? []).map((label) => ({ kind: 'card' as const, label, needsPerson: true }));
  }

  checkout(): Checkout {
    if (!this.checkoutSession) throw new CartError('internal');
    return this.checkoutSession;
  }

  // Built lazily, because it costs a second page and a token: a job that only
  // fills a cart never needs one.
  async openCheckout(): Promise<Checkout | null> {
    if (this.checkoutSession) return this.checkoutSession;
    const cart = await this.raw.fill(this.wanted.map(({ item, quantity }) => ({ item, quantity })));
    if (!cart.ok || cart.cartId === null) return null;

    const phone = phoneFromStorage((await this.page.evaluate(`localStorage.getItem('auth')`)) as string | null);
    if (!phone) throw new CartError('internal');

    // zpaykit refuses a blinkit.com origin at CORS, so its calls are made
    // from a zomato.com page. A different origin cannot touch the Blinkit
    // cart, so opening one is safe.
    this.zomato ??= await this.page.context().newPage();
    await this.zomato.goto(`${ZPAYKIT_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
    await this.zomato.waitForTimeout(PAGE_SETTLE_MS);

    const token = await this.raw.createOrder(cart.cartId);
    if (!token.ok || !token.paymentToken) throw new CartError('internal');

    const call = (this.raw as unknown as {
      call(p: string, m: 'GET' | 'POST' | 'PUT', b?: unknown): Promise<{ status: number; body: string }>;
    }).call.bind(this.raw);

    this.checkoutSession = new BlinkitCheckout({
      pay: new BlinkitPaySession(call, this.zomato, token.paymentToken),
      zomato: this.zomato,
      blinkitCall: call,
      cartId: String(cart.cartId),
      cartLines: cart.lines.length,
      addressLabel: this.address?.label ?? null,
      phone,
    });
    return this.checkoutSession;
  }

  async close(): Promise<void> {
    await this.raw.close();
  }
}

const EMPTY_BILL = { itemTotal: null, toPay: null, delivery: null, surge: null, smallCart: null, other: null, freeDeliveryAbove: null };

// The vendor's own cart answer, in the shape the rest of the app reads.
// Blinkit has no surge or small-cart line of its own, and saying null is not
// the same as saying zero.
function toCartState(filled: Awaited<ReturnType<RawCart['fill']>>): CartState {
  return {
    lines: filled.lines.map((l) => ({ sku: String(l.productId), name: l.name, quantity: l.quantity })),
    bill: {
      itemTotal: filled.subtotal,
      toPay: filled.total,
      delivery: filled.deliveryFee,
      surge: null,
      smallCart: null,
      // Handling, late-night, small-cart, the donation: the vendor sums them
      // into one number and so do we. Without it the bill read 10 + 30 = 98.
      other: filled.additionalCharge,
      freeDeliveryAbove: filled.freeDeliveryAbove,
    },
    serving: filled.ok,
    eta: null,
    message: null,
    statuses: [],
  };
}

export function blinkitCartSessionAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    // `deliverTo` is the address the household chose. A label alone is not
    // enough on this vendor: the coordinates choose the store, so a session
    // opened without the real address would fill a cart at whatever shop the
    // last one left behind.
    async open(session: CapturedSession, deliverTo: VendorAddress | string | null): Promise<CartSession> {
      if (!deliverTo || typeof deliverTo === 'string') throw new CartError('address_needed');
      const raw = await blinkitCartAdapter(launch).open(session, deliverTo);
      const page = (raw as unknown as { page: Page }).page;
      return new BlinkitCartSession(raw, page, deliverTo);
    },
  };
}

export { BLINKIT_ORIGIN };
