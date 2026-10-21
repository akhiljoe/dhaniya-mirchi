// Filling a household's Instamart cart (design §19 Ordering stage 1,
// Appendix C "the cart"). Proven against a real account by
// `spike/instamart/cart-fill.ts`, which this is the worker's copy of.
//
// Instamart refuses an add made by our own fetch (it signs its page's
// requests), so items go in through the page's own buttons: search, the
// product's +, the pack picker's row, Confirm. Reading the cart and clearing
// it do work as plain calls.
//
// Rules that came out of the recon, each one a bug we hit:
//  - the card is found by its image files, never by the product name (the
//    page scrambles names) and never by position;
//  - the pack is chosen by its own name and price in the picker;
//  - the cart is TOPPED UP to the wanted count, never trimmed to it: adding 2
//    to a cart that already held 2 made 4, so the count is read first - but
//    anything above what the list asks for is left alone, because the
//    household adds its own things while we fill (2026-09-21);
//  - the browser profile must not carry a saved cart: on load the page pushes
//    its local copy back to the server, which undid a removal.
import type { BrowserContext, Page } from 'playwright-core';

import {
  CART_ADDRESS_WAIT_MS,
  CART_STEP_SETTLE_MS,
  CART_STEP_TIMEOUT_MS,
  CART_TAP_MS,
  INSTAMART_CART_PAGE,
  INSTAMART_ORIGIN,
  INSTAMART_PAYMENT_OPTIONS_PATH,
  INSTAMART_PAYMENT_WAIT_MS,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
} from '../../constants.js';
import { leaseBrowser, type BrowserLease } from '../warm-browser.js';
import { InstamartCheckout } from './instamart-checkout.js';
import type { Checkout } from './checkout.js';
import type { CapturedSession } from '../connect.js';
import {
  findBySearch,
  findVariation,
  pickAddress,
  readAddresses,
  readCartState,
  readCustomerId,
  type CartState,
  type VendorAddress,
} from './instamart-catalog.js';

export type CartErrorCode =
  | 'unauthorized'
  | 'unreachable'
  | 'address_needed'
  | 'internal'
  // Paying (design §19 stages 2-3). Every one of these is a stop BEFORE the
  // button that spends money, except where the code says otherwise.
  | 'empty_cart'
  // The cart has things in it and the vendor still offers no way to check
  // out: on Blinkit a small cart gets no Proceed bar at all.
  | 'cart_too_small'
  | 'no_payment_screen'
  | 'card_not_found'
  // The payment screen offered no saved card at all.
  | 'no_saved_cards'
  | 'no_cvv_box'
  | 'cvv_not_accepted' // the box did not take the CVV whole, so it was not sent
  | 'no_pay_button'
  | 'no_on_delivery'
  | 'no_otp_box'
  | 'otp_not_accepted' // the bank's box did not take the code whole
  | 'total_changed' // the screen wants more than the household agreed to
  | 'wrong_address' // the order would go somewhere they did not choose
  | 'cart_changed' // the cart holds something other than what they looked at
  | 'no_secret' // the household never sent the CVV or the OTP
  | 'not_paid' // an order exists and the money did not move
  | 'unconfirmed'; // an order exists and the vendor will not say either way

export class CartError extends Error {
  constructor(readonly code: CartErrorCode) {
    super(code);
  }
}

// One line the household wants in its cart.
export interface CartWant {
  item: string; // the canonical item ("milk"), for the result
  product: string; // the vendor's own product name, or what to search for
  pack: string; // the pack label ("500 ml"); ignored when searching
  qty: number;
  // 'exact': this product in this pack, as the household has bought it.
  // 'search': something the household has never bought (a recipe's new
  // ingredient) — whatever the store sells under that name, cheapest pack in
  // stock. What was added is in the result, so nothing is added blind.
  match?: 'exact' | 'search';
  // The rest of the household's ranking for this item, for when the store
  // has not got the first: products they have bought before, best first,
  // each with its pack. The worker takes the first the store has and says
  // which it took (adapters/alternatives.ts).
  alternatives?: { product: string; pack: string }[];
}

// 'removed' is never produced any more - a fill tops the cart up and never
// trims it - but old jobs stored it, so the type still carries it.
export type CartLineState = 'added' | 'already_there' | 'removed' | 'out_of_stock' | 'not_listed' | 'failed';

export interface CartLineResult {
  item: string;
  product: string;
  pack: string;
  wanted: number;
  inCart: number;
  state: CartLineState;
  price: number | null;
  note: string | null;
}

export type { VendorAddress };

export interface CartSession {
  timings?: Record<string, number>;
  addressAnswer?: { status: number; length: number; hasAddresses: boolean } | null;
  // Which address this cart is for. Instamart keeps a cart per store, and
  // the store follows from the address, so the household's own address must
  // be chosen every time: otherwise the worker fills a different cart from
  // the one the app shows (seen on the real account, 2026-09-20).
  address: VendorAddress | null;
  addresses(): Promise<VendorAddress[]>;
  useAddress(address: VendorAddress): Promise<boolean>;
  state(): Promise<CartState>;
  set(want: CartWant): Promise<CartLineResult>;
  // What this account can pay with, read from the vendor's own checkout
  // (design §19 stage 2). Read-only: asking costs nothing and places nothing.
  paymentOptions(): Promise<PaymentOption[]>;
  // Put a cart back together in THIS browser, for a vendor whose cart cannot
  // travel between jobs.
  //
  // Instamart's cart is the account's: the worker fills it in one job and
  // the checkout finds it in the next. Blinkit's belongs to the browser that
  // filled it - not to the account and not to the device, both of which were
  // ruled out by measurement (see the implementation) - so the order job
  // opens a fresh browser onto an empty cart and there is nothing to pay for
  // until this has run. Absent on vendors that do not need it.
  refill?(wanted: CartWant[]): Promise<CartLineResult[]>;
  // The payment screen, for a session that can reach it (design §19 stages
  // 2-3). Absent on a stand-in that only fills carts.
  checkout?(): Checkout;
  close(): Promise<void>;
}

// One way this household could pay. `needsPerson` is the part that decides
// whether an order can be placed without anybody there: a card wants its CVV
// and then the bank's OTP, a wallet wants its own app, netbanking wants a
// bank login (recorded 2026-09-21, design §19 stage 3).
export interface PaymentOption {
  kind: 'card' | 'wallet' | 'netbanking' | 'on_delivery' | 'upi' | 'other';
  label: string;
  needsPerson: boolean;
}

// The answer the page's own call gets, read for the two things that matter:
// did it answer at all, and what can this account pay with.
//
// `statusCode` 0 is the vendor's "Executed Successfully"; 999 is what our own
// unsigned fetch of the same path is told ("Session expired"), and anything
// that is not a clear success is read as "we do not know" - an empty list -
// never as "nothing is available" (design §9.3 applied to payment: never a
// confident wrong answer).
//
// `codEnabled` is the one flag the vendor states outright. The rest of the
// answer is its own widget language, so the kinds are read from the words it
// uses, and anything unrecognised is 'other' and assumed to need a person -
// never the other way round.
export function readPaymentOptions(body: string): PaymentOption[] {
  let status: unknown;
  let cod: unknown;
  try {
    const json = JSON.parse(body) as { statusCode?: unknown; data?: { codEnabled?: unknown } };
    status = json.statusCode;
    cod = json.data?.codEnabled;
  } catch {
    return [];
  }
  if (status !== 0) return [];
  const found: PaymentOption[] = [];
  const seen = new Set<string>();
  if (cod === true) {
    seen.add('on_delivery');
    found.push({ kind: 'on_delivery', label: 'Pay on Delivery', needsPerson: false });
  }
  const rules: { kind: PaymentOption['kind']; re: RegExp; label: string; needsPerson: boolean }[] = [
    { kind: 'on_delivery', re: /pay on delivery|cash on delivery|\bcod\b/i, label: 'Pay on Delivery', needsPerson: false },
    { kind: 'card', re: /credit ?&? ?debit|\bcards?\b/i, label: 'Cards', needsPerson: true },
    { kind: 'wallet', re: /wallets?|phonepe|amazon pay/i, label: 'Wallets', needsPerson: true },
    { kind: 'netbanking', re: /net ?banking/i, label: 'Netbanking', needsPerson: true },
    { kind: 'upi', re: /\bupi\b/i, label: 'UPI', needsPerson: true },
  ];
  for (const r of rules) {
    if (!r.re.test(body) || seen.has(r.kind)) continue;
    seen.add(r.kind);
    found.push({ kind: r.kind, label: r.label, needsPerson: r.needsPerson });
  }
  return found;
}

async function inPage(page: Page, path: string, init: { method: 'GET' | 'POST'; json?: unknown }) {
  const args = JSON.stringify({ path, method: init.method, body: init.json === undefined ? null : JSON.stringify(init.json) });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, {
      method: a.method,
      credentials: 'include',
      headers: a.body ? { 'content-type': 'application/json' } : {},
      body: a.body,
    });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

const CART_PATH = '/api/instamart/checkout/v2/cart?pageType=INSTAMART_HOME';
const SEARCH_PATH = '/api/instamart/search/v2';

class InstamartCartSession implements CartSession {
  address: VendorAddress | null = null;
  // What the app answered when asked for the saved addresses: counts only,
  // never the addresses themselves, so a failure can be looked into.
  addressAnswer: { status: number; length: number; hasAddresses: boolean } | null = null;
  // The last answer the PAGE got when it asked what the account can pay with:
  // held raw only until it is read, never logged and never stored.
  private paymentAnswer: string | null = null;
  private checkoutSession: Checkout | null = null;
  private customer: string | null | undefined;
  // Every tap is answered with the whole cart, so the answer to the last tap
  // is what the cart holds: no extra read before or after an item.
  private latest: CartState | null = null;
  // True while a tap has changed the cart and its answer has not arrived:
  // `latest` is then out of date and the cart is read instead.
  private stale = false;

  constructor(
    private readonly lease: BrowserLease,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {
    // A tap that cannot land must fail quickly, not hold the whole cart.
    page.setDefaultTimeout(CART_STEP_TIMEOUT_MS);
    // The cart page's own scripts ask what this account can pay with. That
    // call is signed, so our own fetch of the same path is told "Session
    // expired" (probed 2026-09-21); watching the page be answered is the only
    // way to read it, exactly as an add to cart has to go through the page's
    // own button (design Appendix C).
    page.on('response', (r) => {
      if (!r.url().includes(INSTAMART_PAYMENT_OPTIONS_PATH)) return;
      void r
        .text()
        .then((body) => {
          this.paymentAnswer = body;
        })
        .catch(() => {});
    });
    page.on('response', (r) => {
      if (!/\/api\/instamart\/checkout\/v2\/cart/.test(r.url()) || r.request().method() !== 'POST') return;
      void r
        .text()
        .then((body) => {
          this.latest = readCartState(JSON.parse(body));
          this.stale = false;
        })
        .catch(() => {});
    });
  }

  // Taps that change the cart are answered by the app's own cart call. Only
  // the last tap of an item waits for that answer: the ones before it just
  // need the page to register them, and the answer to the last one is the
  // cart. `changesCart` false is a tap that only opens something (the pack
  // picker).
  private async tap(what: Promise<unknown>, changesCart: boolean, awaitAnswer = true): Promise<void> {
    const started = Date.now();
    try {
      await this.tapInner(what, changesCart, awaitAnswer);
    } finally {
      this.timings.taps = (this.timings.taps ?? 0) + Date.now() - started;
    }
  }

  private async tapInner(what: Promise<unknown>, changesCart: boolean, awaitAnswer: boolean): Promise<void> {
    if (!changesCart || !awaitAnswer) {
      this.stale = this.stale || changesCart;
      await what;
      await this.page.waitForTimeout(CART_TAP_MS);
      return;
    }
    this.stale = true;
    const answered = this.page
      .waitForResponse((r) => /\/api\/instamart\/checkout\/v2\/cart/.test(r.url()) && r.request().method() === 'POST', { timeout: CART_STEP_TIMEOUT_MS })
      .catch(() => null);
    await what;
    await answered;
    await this.page.waitForTimeout(CART_STEP_SETTLE_MS);
  }

  // The addresses saved in the app. `actual_address` is a JSON string with
  // the household's own label for it.
  // The app answers with the saved addresses only when asked for a given
  // account ("customerId"), which the order list carries.
  async customerId(): Promise<string | null> {
    if (this.customer !== undefined) return this.customer;
    const r = await inPage(this.page, `/api/instamart/orders?order_type=DASH&count=1&from_time=${Date.now()}`, { method: 'GET' });
    if (r.status === 401 || r.status === 403) throw new CartError('unauthorized');
    try {
      this.customer = readCustomerId(JSON.parse(r.body));
    } catch {
      this.customer = null;
    }
    return this.customer;
  }

  async addresses(): Promise<VendorAddress[]> {
    const customer = await this.customerId();
    const r = await inPage(this.page, `/api/instamart/maps/getUserAddresses${customer ? `?customerId=${encodeURIComponent(customer)}` : ''}`, { method: 'GET' });
    if (r.status === 401 || r.status === 403) throw new CartError('unauthorized');
    this.addressAnswer = { status: r.status, length: r.body.length, hasAddresses: /actual_address/.test(r.body) };
    try {
      return readAddresses(JSON.parse(r.body));
    } catch {
      return []; // a shape we don't know: no addresses rather than a guess
    }
  }

  // Deliver to this address, the same call the app's own address picker
  // makes. The store (and so which cart is shown) follows from it.
  async useAddress(address: VendorAddress): Promise<boolean> {
    const r = await inPage(this.page, '/api/instamart/home/select-location/v2', {
      method: 'POST',
      json: {
        data: {
          lat: address.lat,
          lng: address.lng,
          address: address.display,
          addressId: address.id,
          annotation: address.label,
          name: address.name,
          clientId: 'INSTAMART-APP',
        },
      },
    });
    if (r.status === 401 || r.status === 403) throw new CartError('unauthorized');
    this.latest = null;
    this.stale = true;
    if (r.status === 200) this.address = address;
    return r.status === 200;
  }

  async state(): Promise<CartState> {
    const r = await inPage(this.page, CART_PATH, { method: 'GET' });
    if (r.status === 401 || r.status === 403) throw new CartError('unauthorized');
    if (r.status !== 200) throw new CartError('unreachable');
    try {
      this.latest = readCartState(JSON.parse(r.body));
      this.stale = false;
      return this.latest;
    } catch {
      throw new CartError('unreachable'); // an HTML challenge page served with 200
    }
  }

  // Search through the page, so the answer is the one the page is showing.
  // The first item loads the search page; the rest type in its box, which
  // saves a page load each (several seconds an item).
  private async search(query: string): Promise<unknown> {
    const answer = this.page.waitForResponse((r) => r.url().includes(SEARCH_PATH) && r.request().method() === 'POST', { timeout: PAGE_LOAD_TIMEOUT_MS });
    const box = this.page.locator('input[placeholder*="Search" i], input[type="search"]').first();
    const typing = this.page.url().includes('/search') && (await this.timed('search:box?', () => box.count()));
    if (typing) {
      await this.timed('search:type', async () => {
        await box.fill(query);
        await this.page.keyboard.press('Enter');
      });
    } else {
      // The search answer is what matters, not every image on the page.
      await this.timed('search:load', () =>
        this.page.goto(`${INSTAMART_ORIGIN}/search?custom_back=true&query=${encodeURIComponent(query)}`, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_LOAD_TIMEOUT_MS,
        }),
      );
    }
    const body = await this.timed('search:answer', async () => (await answer).text());
    // The cards are drawn from that answer: wait for the first + to exist.
    await this.timed('search:cards', () =>
      this.page.locator('[data-testid="buttonpair-add"]').first().waitFor({ timeout: CART_STEP_TIMEOUT_MS }).catch(() => {}),
    );
    // A first-visit tip ("Refine results… Got it!") sits over the first card.
    // It is taken out of the page rather than tapped: tapping it waited on a
    // moving target and cost 15 seconds an item.
    await this.timed('search:tip', () =>
      this.page.evaluate(`[...document.querySelectorAll('div,span,button')]
        .filter((e) => e.children.length === 0 && /^\\s*got it!?\\s*$/i.test(e.textContent || ''))
        .forEach((e) => (e.closest('[class]') || e).remove())`),
    );
    try {
      return JSON.parse(body);
    } catch {
      throw new CartError('unreachable');
    }
  }

  // Which + belongs to the listing holding this pack: the one whose card
  // shows one of the listing's images.
  private async plusIndexFor(imageKeys: string[]): Promise<number> {
    return (await this.page.evaluate(`(() => {
      const keys = ${JSON.stringify(imageKeys)};
      const plus = [...document.querySelectorAll('[data-testid="buttonpair-add"]')];
      return plus.findIndex((b) => {
        let x = b.parentElement;
        while (x.parentElement && x.parentElement.querySelectorAll('[data-testid="buttonpair-add"]').length === 1) x = x.parentElement;
        const srcs = [...x.querySelectorAll('img')].map((i) => decodeURIComponent(i.currentSrc || i.src || ''));
        return srcs.some((s) => keys.some((k) => s.includes(k)));
      });
    })()`)) as number;
  }

  // How long each part took, for the worker's log: filling a cart is the
  // slowest thing the app does, so it is measured, not guessed.
  timings: Record<string, number> = {};
  private async timed<T>(what: string, run: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try {
      return await run();
    } finally {
      this.timings[what] = (this.timings[what] ?? 0) + Date.now() - t;
    }
  }

  // What this account can pay with (design §19 stage 2). Read-only: the cart
  // page is opened and its own question is overheard. Nothing is ordered and
  // no money moves - the recorded checkout only reaches the order call once a
  // method is chosen and Pay is pressed.
  //
  // An answer we cannot read gives an empty list - "we do not know" - never a
  // guess that something is available. The page asks only when there is a
  // cart to pay for, so an empty cart also answers nothing.
  //
  // It navigates, so it belongs after a cart is filled, never between taps.
  async paymentOptions(): Promise<PaymentOption[]> {
    return this.timed('payment options', async () => {
      this.paymentAnswer = null;
      await this.page.goto(`${INSTAMART_ORIGIN}${INSTAMART_CART_PAGE}`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
      const until = Date.now() + INSTAMART_PAYMENT_WAIT_MS;
      while (this.paymentAnswer === null && Date.now() < until) await this.page.waitForTimeout(CART_TAP_MS);
      const body = this.paymentAnswer;
      this.paymentAnswer = null;
      this.stale = true; // the cart page is not where a tap expects to be
      return body === null ? [] : readPaymentOptions(body);
    });
  }

  // The payment screen, driven through this same page. Made once: it listens
  // for the order call, and two listeners would report one order twice.
  checkout(): Checkout {
    this.checkoutSession ??= new InstamartCheckout(this.page);
    return this.checkoutSession;
  }

  async set(want: CartWant): Promise<CartLineResult> {
    const line = (state: CartLineState, inCart: number, price: number | null = null, note: string | null = null): CartLineResult => ({
      item: want.item,
      product: want.product,
      pack: want.pack,
      wanted: want.qty,
      inCart,
      state,
      price,
      note,
    });

    const answer = await this.timed('search', () => this.search(want.product));
    const found = want.match === 'search' ? findBySearch(answer, want.product) : findVariation(answer, want.product, want.pack);
    if (!found.variation) {
      return line('not_listed', 0, null, found.packsSeen.length ? `packs here: ${found.packsSeen.join(', ')}` : null);
    }
    // Searching takes what the store has, so the result says what that was.
    if (want.match === 'search') {
      want = { ...want, product: found.variation.displayName, pack: found.variation.quantityDescription };
    }
    const { variation, price, inStock, imageKeys } = found;
    const before = this.stale || !this.latest ? await this.timed('read', () => this.state()) : this.latest;
    const have = before.lines.find((l) => l.sku === variation.skuId)?.quantity ?? 0;
    // Never take anything out. The household keeps shopping in the app while
    // we fill - that is the whole point of Send being something you can walk
    // away from - and a fill that removed what they had just added would be
    // worse than one that did nothing. More in the cart than the list asks for
    // is their decision, not a mistake to correct.
    if (have >= want.qty) return line('already_there', have, price);
    if (!inStock && want.qty > have) return line('out_of_stock', have, price);

    const delta = want.qty - have;
    const index = await this.timed('find card', () => this.plusIndexFor(imageKeys));
    if (index < 0) return line('failed', have, price, 'the product is not on the page');
    const plus = this.page.locator('[data-testid="buttonpair-add"]').nth(index);
    await plus.scrollIntoViewIfNeeded();
    // With some in the cart the card shows − n +; either button opens the
    // pack picker for a product sold in several packs.
    const pairOf = (l = plus) => l.locator('xpath=ancestor::*[.//*[@data-testid="buttonpair-remove"]][1]');
    // On a product with packs this only opens the picker; otherwise it
    // already changes the cart.
    const singlePack = found.packsSeen.length <= 1;
    await this.tap(plus.click(), singlePack);

    const confirm = this.page.getByText(/^confirm$/i).first();
    const hasPicker = await this.timed('picker?', () => confirm.isVisible().catch(() => false));
    if (hasPicker) {
      const rows = this.page.locator('[data-testid="variants-container"]');
      let row = null;
      for (let i = 0; i < (await rows.count()); i++) {
        const r = rows.nth(i);
        const names = (await r.locator('[data-testid="variants-name"]').allTextContents()).map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim()).join(' ');
        const rowPrice = (await r.locator('[data-testid="variants-price"]').first().textContent())?.trim();
        if (names === want.pack.toLowerCase().trim() && rowPrice === String(price)) row = r;
      }
      if (!row) {
        await this.page.keyboard.press('Escape');
        return line('failed', have, price, 'this pack was not in the picker');
      }
      let steps = delta;
      if (have === 0) {
        await this.tap(row.locator('[data-testid="add_buttons_center"]').click(), true, steps === 1);
        steps -= 1;
      }
      for (let i = 0; i < steps; i++) {
        await this.tap(row.locator('[data-testid="add_buttons_plus"]').click(), true, i === steps - 1);
      }
      await confirm.click();
    } else {
      const steps = delta;
      for (let i = 1; i < steps; i++) {
        await this.tap(pairOf().locator('[data-testid="buttonpair-add"]').first().click(), true, i === steps - 1);
      }
    }

    // What the cart really holds now decides what we report: the answer to
    // the last tap, or a read if no answer came.
    const after = this.stale || !this.latest ? await this.timed('read', () => this.state()) : this.latest;
    const inCart = after.lines.find((l) => l.sku === variation.skuId)?.quantity ?? 0;
    if (inCart === want.qty) return line('added', inCart, price);
    return line('failed', inCart, price, `the cart holds ${inCart}`);
  }

  // The browser stays warm for the next cart; this job's own context, with
  // its cookies and its copy of the cart, goes.
  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.lease.release();
  }
}

export function instamartCartAdapter(lease: () => Promise<BrowserLease> = () => leaseBrowser()) {
  return {
    // `deliverTo`: the address the household chose for this app, or just the
    // label its orders go to. The store — and so which cart the app shows —
    // follows from it, so it is chosen every time.
    async open(session: CapturedSession, deliverTo: VendorAddress | string | null): Promise<CartSession> {
      const addressLabel = typeof deliverTo === 'string' ? deliverTo : (deliverTo?.label ?? null);
      // A browser kept warm between carts, and this job's own context inside
      // it: its own cookies and its own copy of the cart (warm-browser.ts).
      const held = await lease();
      let context: BrowserContext | null = null;
      try {
        context = await held.browser.browser.newContext({ userAgent: held.browser.userAgent });
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
        await context.addInitScript(
          `if (location.origin === ${JSON.stringify(INSTAMART_ORIGIN)}) {
             const s = ${JSON.stringify(session.localStorage)};
             for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
           }`,
        );
        const page = await context.newPage();
        // Nothing here is looked at, so pictures, fonts and trackers are not
        // fetched: the pages the worker walks through load in a fraction of
        // the time. The image ADDRESSES stay in the page, which is what finds
        // the right card.
        await page.route('**/*', (route) => {
          const type = route.request().resourceType();
          const url = route.request().url();
          if (type === 'image' || type === 'font' || type === 'media' || /analytics|swiggylitics|fraudnabuse|newrelic|clarity|gtm|doubleclick/.test(url)) {
            return route.abort();
          }
          return route.continue();
        });
        const res = await page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        if (!res || res.status() !== 200) throw new CartError('unreachable');
        await page.waitForTimeout(PAGE_SETTLE_MS);

        const cart = new InstamartCartSession(held, context, page);

        // The household's own address, every time: the cart belongs to the
        // store that address is served by. Its own label is matched first;
        // with no label, the one the app already had.
        const saved = await cart.addresses();
        const wanted = typeof deliverTo === 'object' && deliverTo ? deliverTo : pickAddress(saved, addressLabel);
        if (wanted) {
          await cart.useAddress(wanted);
          await page.waitForTimeout(PAGE_SETTLE_MS);
        } else if (await page.getByText(/share location to find/i).first().isVisible().catch(() => false)) {
          // Nothing matched: fall back to the app's own picker, which lists
          // the saved addresses by their labels.
          if (!addressLabel) throw new CartError('address_needed');
          const pick = page.getByText(addressLabel).first();
          if (!(await pick.waitFor({ timeout: CART_ADDRESS_WAIT_MS }).then(() => true, () => false))) throw new CartError('address_needed');
          await pick.click();
          await page.waitForTimeout(PAGE_SETTLE_MS);
        }
        return cart;
      } catch (err) {
        await context?.close().catch(() => undefined);
        await held.release();
        throw err;
      }
    },
  };
}
