// Driving the vendor's payment screen (design §19 stages 2-3).
//
// Stage 1 filled the cart and stopped. This goes one screen further: it opens
// the payment screen, checks that what is about to be paid is what the
// household agreed to, and - for a card - types the CVV they sent and then
// the OTP their bank sent, each one relayed through our page and never
// stored.
//
// The one fact that shapes every line here: **the vendor creates the order
// before the money moves.** `POST /api/v3/instamart/checkout/order` answers
// `PLACED` with `payment_status: PENDING`, and only then does the gateway
// chain start. So:
//
//   * `pay()` is the only function in this file that can spend money, and it
//     reports the exact moment it pressed the button. After that moment a
//     caller may never retry: a second press is a second order.
//   * An order id seen on the wire is remembered even when the payment then
//     fails, because "an order exists and was not paid for" is a real state
//     the household has to be told about (design §19).
//
// Nothing here ever holds a CVV or an OTP for longer than the call that types
// it, and neither is ever logged, stored, or included in an error.
import type { Locator, Page } from 'playwright-core';

import type { Checkout } from './checkout.js';
import {
  CHECKOUT_BANK_HOSTS,
  CHECKOUT_BANK_WAIT_MS,
  CHECKOUT_NOT_BANK_HOSTS,
  CHECKOUT_SCREEN_TIMEOUT_MS,
  INSTAMART_CHECKOUT,
  INSTAMART_ITEM_COUNT_PATTERN,
  INSTAMART_ORDER_PATH,
  INSTAMART_ORIGIN,
  INSTAMART_RECENT_ORDERS_PATH,
  INSTAMART_TOTAL_PATTERN,
  ORDER_CONFIRM_POLL_MS,
  ORDER_CONFIRM_WAIT_MS,
  ORDER_DEAD_STATUSES,
  OTP_BOX_WAIT_MS,
  OTP_BOX_WORDS,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
  PROCEED_WAIT_MS,
} from '../../constants.js';
import { CartError } from './instamart-cart.js';

// The payment screen puts a card's name and its last digits on two lines, so
// every name off this screen is squashed to one before it is stored, shown or
// matched. Without it the app would store "Alex Bank Card\n1111",
// the api would tidy it to one space on the way back, and the row would never
// be found again.
export function cardName(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// What the payment screen says, as the household would read it.
export interface PaymentScreen {
  total: number | null; // rupees, from the screen's own subtitle
  items: number | null; // how many lines it is about to charge for
  address: string | null; // the address tag the order would go to
  cards: string[]; // the saved cards, by the name the screen shows
  onDelivery: boolean; // is Pay on Delivery on this screen
}

// "1 item. Total: ₹94" → 94. Anything unreadable is null, never a guess: this
// number is what the household's cap is checked against.
export function readTotal(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(INSTAMART_TOTAL_PATTERN);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "1 item. Total: 94" -> 1. Null when the screen does not say, which is
// never read as "no items" (design §9.3).
export function readItemCount(text: string | null): number | null {
  const m = text?.match(INSTAMART_ITEM_COUNT_PATTERN);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Is this frame the household's bank, putting up its own page?
//
// Judged on the HOST, never the whole URL. A checkout page carries ad and
// analytics frames, and their URLs are full of the same words: Google's ad
// host is `securepubads.g.doubleclick.net`, and a conversion pixel carries
// "authenticate" and "secure" in its query. Matching those said "the bank is
// asking" before the bank had said anything, which in the payment path means
// waiting for - or asking the household for - an OTP that will never come.
//
// Exported for its tests: this cannot be tried against a real bank on demand.
export function isBankPage(url: string, vendorOrigin: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // The vendor's own frames are not the bank's.
  try {
    if (host.endsWith(new URL(vendorOrigin).hostname.toLowerCase())) return false;
  } catch {
    // A vendor origin we cannot parse is not a reason to call this the bank.
  }
  if (CHECKOUT_NOT_BANK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;
  return CHECKOUT_BANK_HOSTS.test(host);
}

// The vendor's own answer to the order call, read for the two things that
// have to be told apart: does an order now exist, and was it paid for.
//
// It looks anywhere in the answer rather than at one agreed place. The first
// version read `data.order_id` and found nothing on a live order (2026-09-22)
// - the household was left with an order we could not name. Being unable to
// say WHICH order is unpaid is nearly as bad as not knowing there is one.
export function readOrderAnswer(body: string): { orderId: string | null; paid: boolean } {
  let orderId: string | null = null;
  let paid = false;
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (orderId === null && /^(order_?id|orderNumber|order_no)$/i.test(k) && (typeof x === 'string' || typeof x === 'number')) {
        const asText = String(x).trim();
        if (asText) orderId = asText;
      }
      if (/^(payment_?status|order_?status|status)$/i.test(k) && typeof x === 'string') {
        const state = x.toUpperCase();
        if (state === 'PAID' || state === 'SUCCESS' || state === 'COMPLETED') paid = true;
      }
      walk(x, depth + 1);
    }
  };
  try {
    walk(JSON.parse(body), 0);
  } catch {
    return { orderId: null, paid: false };
  }
  return { orderId, paid };
}

// On screen and not merely in the markup: the payment screen keeps both
// cards' rows in the page and shows only the chosen one's controls.
async function seen(what: Locator): Promise<boolean> {
  if (!(await what.count())) return false;
  return what.isVisible().catch(() => false);
}

// A card row is the chosen one when it is showing a way to pay: its own CVV
// box, or its own Pay button. That is steadier than the tick's own attribute,
// which is the vendor's to rename.
async function rowChosen(row: Locator): Promise<boolean> {
  if (await seen(row.locator(INSTAMART_CHECKOUT.cardPay).first())) return true;
  return seen(row.locator(INSTAMART_CHECKOUT.cardCvv).first());
}

// One box on the bank's page, as the worker can see it without typing
// anything.
export interface OtpBox {
  index: number;
  type: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  maxLength: number; // -1 when the page does not say
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
}

// Which boxes to type the code into. The bank's page is nobody's to control,
// so this reads shape rather than names, and says plainly when it cannot
// tell rather than typing into the first thing it finds.
//
//   * A box that cannot be typed into is never chosen: hidden, disabled and
//     read-only ones are how a page marks what is not for you.
//   * Many banks split the code across one box per digit. Several boxes that
//     each take a single character are that, and get one digit each.
//   * Otherwise the one box that looks most like the code's: named for it
//     first, then long enough to hold it.
export function chooseOtpBoxes(boxes: OtpBox[], digits: number): OtpBox[] {
  const usable = boxes.filter((b) => b.visible && !b.disabled && !b.readOnly);
  if (!usable.length) return [];

  // One box per digit.
  const single = usable.filter((b) => b.maxLength === 1);
  if (single.length >= digits) return single.slice(0, digits);

  const named = usable.filter((b) => OTP_BOX_WORDS.test(`${b.name ?? ''} ${b.id ?? ''} ${b.placeholder ?? ''} ${b.ariaLabel ?? ''}`));
  const roomFor = (b: OtpBox) => b.maxLength === -1 || b.maxLength >= digits;
  const best = named.find(roomFor) ?? named[0] ?? usable.filter(roomFor)[0];
  return best ? [best] : [];
}

export interface PayResult {
  pressedAt: Date;
  orderId: string | null;
  paid: boolean;
  bankAsked: boolean; // a 3-D Secure page appeared: an OTP is needed
  // What the BANK says it is about to take, off its own page, or null when
  // its page does not say.
  //
  // This is the only figure in the whole flow that cannot be stale. The
  // vendor's cart can change between the household agreeing to a price and
  // the gateway being called - live on 2026-09-23 the app showed Rs 320 and
  // the bank asked for Rs 255, one item having gone - and by then the order
  // exists and the checkout's own number is history. So the household is
  // shown this one when it exists, beside the code box, and it is what they
  // are actually agreeing to when they type.
  bankTotal: number | null;
}

// What the bank's page says it is taking.
//
// Chosen the way the code box is: by shape, and cautiously. A 3-D Secure page
// belongs to the bank, differs at every one of them, and can change without
// warning - so this reads only the plainest statements of an amount, prefers
// one that a word like "amount" or "payable" introduces, and says null rather
// than pick a number out of a page it did not understand. A wrong number here
// would be worse than none: it is shown to a household as what they are about
// to be charged.
const BANK_AMOUNT_LABELS: RegExp[] = [
  /(?:amount|total|payable|purchase|txn|transaction)\s*(?:amount)?\s*:?\s*(?:inr|rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  /(?:inr|rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:will be|is|to be)?\s*(?:debited|charged|payable)/i,
];

export function bankAmountFrom(text: string): number | null {
  const flat = text.replace(/\s+/g, ' ');
  for (const label of BANK_AMOUNT_LABELS) {
    const m = flat.match(label);
    if (!m) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Type the bank's code into the bank's own page.
//
// Shared by every vendor, because this is the one surface nobody here
// controls: each bank's page differs, none of it is ours, and it can change
// without warning. One copy means one set of rules, and the rules are the
// careful part - the box is chosen by SHAPE, never by taking the first input,
// and the code is read back after typing because a half-entered code is a
// decline on an order that already exists.
//
// Returns the shapes that WERE on the page when no box could be found, for
// the log. Shapes only, never a value. Throws `no_otp_box` in that case and
// `otp_not_accepted` when the code would not go in whole.
export async function typeOtpIntoBankPage(
  page: Page,
  otp: string,
  vendorOrigin: string,
): Promise<{ type: string | null; maxLength: number; visible: boolean; named: boolean }[]> {
  const until = Date.now() + OTP_BOX_WAIT_MS;
  let lastSeen: OtpBox[] = [];
  while (Date.now() < until) {
    for (const frame of page.frames()) {
      if (!isBankPage(frame.url(), vendorOrigin)) continue;
      const boxes = (await frame.evaluate(READ_BOXES).catch(() => [])) as OtpBox[];
      if (!boxes.length) continue;
      lastSeen = boxes;
      const chosen = chooseOtpBoxes(boxes, otp.length);
      if (!chosen.length) continue;

      const inputs = frame.locator('input');
      if (chosen.length === 1) {
        await inputs.nth(chosen[0].index).fill(otp, { timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
      } else {
        // One digit per box, as the bank laid it out.
        for (let i = 0; i < chosen.length; i++) await inputs.nth(chosen[i].index).fill(otp[i], { timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
      }

      // It went in whole, or it does not get sent.
      const typed = (await Promise.all(chosen.map((b) => inputs.nth(b.index).inputValue().catch(() => '')))).join('');
      if (typed !== otp) throw new CartError('otp_not_accepted');

      const submit = frame.locator('button[type="submit"], input[type="submit"], button').first();
      if (await submit.count().catch(() => 0)) await submit.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => {});
      else await inputs.nth(chosen[chosen.length - 1].index).press('Enter');
      return [];
    }
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }
  // Every bank's page is different and this one is not ours. Saying what was
  // on it is the only way the next attempt is any wiser than this one.
  const shape = lastSeen.map((b) => ({
    type: b.type,
    maxLength: b.maxLength,
    visible: b.visible,
    named: OTP_BOX_WORDS.test(`${b.name ?? ''} ${b.id ?? ''} ${b.placeholder ?? ''}`),
  }));
  const err = new CartError('no_otp_box');
  (err as CartError & { shape?: unknown }).shape = shape;
  throw err;
}

export type OtpPageShape = { type: string | null; maxLength: number; visible: boolean; named: boolean }[];

export class InstamartCheckout implements Checkout {
  // Everything the order call said, kept so a failure can still say whether
  // an order was left behind.
  private orderId: string | null = null;
  private paidOnOrder = false;
  // The card row the household chose. Everything after that - the CVV box,
  // the button that spends the money - is read from inside this row, never
  // from the page: two cards mean two of each.
  private chosen: Locator | null = null;
  private sawOrderCall = false;

  constructor(private readonly page: Page) {
    page.on('response', (r) => {
      if (!r.url().includes(INSTAMART_ORDER_PATH)) return;
      this.sawOrderCall = true;
      void r
        .text()
        .then((body) => {
          const seen = readOrderAnswer(body);
          // Only ever set, never cleared: once an order exists it exists.
          if (seen.orderId) this.orderId = seen.orderId;
          if (seen.paid) this.paidOnOrder = true;
        })
        .catch(() => {});
    });
  }

  // The order the vendor created, if it got that far. Safe to read at any
  // point, including after a failure - that is what it is for.
  get placedOrderId(): string | null {
    return this.orderId;
  }

  // Was the call that creates an order answered at all? True with no id means
  // an order exists and we cannot name it, which the household still has to
  // be told (the app says so from `pay_pressed_at` as well).
  get orderCallAnswered(): boolean {
    return this.sawOrderCall;
  }

  // Opens the payment screen from the cart. This creates no order: the order
  // call comes only when a method is chosen and Pay is pressed.
  async open(): Promise<PaymentScreen> {
    if (!this.page.url().includes('/cart')) {
      await this.page.goto(`${INSTAMART_ORIGIN}/cart`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
      await this.page.waitForTimeout(PAGE_SETTLE_MS);
    }
    // Wait for the control, rather than glancing once. The vendor draws this
    // bar after it has checked the address can be served, so a glance right
    // after the page load finds nothing and calls a full cart empty - which
    // is what it did, thirteen seconds after opening, to a cart that had four
    // things in it.
    const proceed = this.page.getByText(INSTAMART_CHECKOUT.proceed).first();
    const until = Date.now() + PROCEED_WAIT_MS;
    while (Date.now() < until && !(await proceed.count().catch(() => 0))) {
      await this.page.waitForTimeout(PAGE_SETTLE_MS);
    }
    if (!(await proceed.count())) throw new CartError('empty_cart');
    await proceed.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
    await this.page.waitForSelector(INSTAMART_CHECKOUT.total, { timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => {
      throw new CartError('no_payment_screen');
    });
    return this.read();
  }

  async read(): Promise<PaymentScreen> {
    const text = async (sel: string) => (await this.page.locator(sel).first().count()) ? (await this.page.locator(sel).first().innerText()).trim() : null;
    const subtitle = await text(INSTAMART_CHECKOUT.total);
    return {
      total: readTotal(subtitle),
      items: readItemCount(subtitle),
      address: await text(INSTAMART_CHECKOUT.addressTag),
      cards: await this.page
        .locator(INSTAMART_CHECKOUT.cardName)
        .allInnerTexts()
        .then((xs) => xs.map(cardName).filter(Boolean)),
      onDelivery: (await this.page.locator(INSTAMART_CHECKOUT.onDelivery).count()) > 0,
    };
  }

  // Picks the saved card the household chose, by the name their own screen
  // shows it under. No match is a stop, never "the first one will do":
  // paying with a card they did not pick is not a small mistake.
  //
  // The tick is a TOGGLE, and the screen opens with the preferred card
  // already ticked and its CVV box showing. Tapping it then closes the row
  // instead of opening it, which is what happened live on 2026-09-22: the
  // household typed a CVV and there was nowhere left to put it. So a row that
  // is already chosen is left alone.
  async chooseCard(label: string): Promise<void> {
    const rows = this.page.locator(INSTAMART_CHECKOUT.cardRow);
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const name = cardName(await row.locator(INSTAMART_CHECKOUT.cardName).first().innerText().catch(() => ''));
      if (name !== cardName(label)) continue;
      if (!(await rowChosen(row))) {
        const tick = row.locator(INSTAMART_CHECKOUT.cardTick).first();
        if (await tick.count()) await tick.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
        await this.page.waitForTimeout(PAGE_SETTLE_MS);
      }
      // Whatever the tick said, what matters is that this row is the one now
      // showing a way to pay.
      if (!(await rowChosen(row))) throw new CartError('card_not_found');
      this.chosen = row;
      return;
    }
    throw new CartError('card_not_found');
  }

  // Does the chosen card's row ask for a CVV? Read from the screen, not
  // assumed: a card that is not asked for one should not have the household
  // asked for one either.
  async cvvNeeded(): Promise<boolean> {
    const row = this.chosen;
    if (!row) throw new CartError('card_not_found');
    return seen(row.locator(INSTAMART_CHECKOUT.cardCvv).first());
  }

  // Types the CVV and presses the button that spends the money.
  //
  // `cvv` is typed and dropped. It is never stored on this object, never
  // logged, and never part of an error. The caller drops its own copy too.
  //
  // Everything that could stop the order has to have happened BEFORE this is
  // called: after it returns, an order may exist whatever else went wrong.
  async pay(cvv: string | null): Promise<PayResult> {
    const row = this.chosen;
    if (!row) throw new CartError('card_not_found');
    if (cvv !== null) {
      const box = row.locator(INSTAMART_CHECKOUT.cardCvv).first();
      if (!(await seen(box))) throw new CartError('no_cvv_box');
      await box.fill(cvv, { timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
      // The box is sized to the card - 4 for the American Express on this
      // account, 3 for the others - so a CVV that does not fit is a CVV for
      // another card, or a screen that has changed. Either way, sending half
      // of it means the bank declines an order that by then already exists.
      // Checked here, one line before the only button that spends money, and
      // the number itself never appears in the error.
      if ((await box.inputValue().catch(() => '')) !== cvv) throw new CartError('cvv_not_accepted');
    }
    const button = row.locator(INSTAMART_CHECKOUT.cardPay).first();
    if (!(await seen(button))) throw new CartError('no_pay_button');
    const pressedAt = new Date();
    await button.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
    const bankAsked = await this.waitForBank();
    const bankTotal = bankAsked ? await this.bankTotal() : null;
    return { pressedAt, orderId: this.orderId, paid: this.paidOnOrder, bankAsked, bankTotal };
  }

  // Pay on Delivery: the one method that asks for nothing. Still an order,
  // still money owed, so it presses exactly one button and reports when.
  async payOnDelivery(): Promise<PayResult> {
    const row = this.page.locator(INSTAMART_CHECKOUT.onDelivery).first();
    if (!(await row.count())) throw new CartError('no_on_delivery');
    const pressedAt = new Date();
    await row.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
    await this.page.waitForTimeout(PAGE_SETTLE_MS);
    const button = this.page.locator(INSTAMART_CHECKOUT.cardPay).first();
    if (await button.count()) await button.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
    await this.page.waitForTimeout(PAGE_SETTLE_MS);
    return { pressedAt, orderId: this.orderId, paid: this.paidOnOrder, bankAsked: false, bankTotal: null };
  }

  // Did the household's bank put up its own page? That page is the bank's,
  // not the vendor's and not ours (design §19 stage 3).
  // What the bank's own page says it is about to take. Null when it does not
  // say, which is not an error: many do not.
  private async bankTotal(): Promise<number | null> {
    for (const frame of this.page.frames()) {
      if (!isBankPage(frame.url(), INSTAMART_ORIGIN)) continue;
      const said = await frame
        .locator('body')
        .innerText()
        .catch(() => '');
      const found = bankAmountFrom(said);
      if (found !== null) return found;
    }
    return null;
  }

  private async waitForBank(): Promise<boolean> {
    const until = Date.now() + CHECKOUT_BANK_WAIT_MS;
    while (Date.now() < until) {
      for (const frame of this.page.frames()) {
        if (isBankPage(frame.url(), INSTAMART_ORIGIN)) return true;
      }
      if (this.orderId && this.paidOnOrder) return false;
      await this.page.waitForTimeout(PAGE_SETTLE_MS);
    }
    return false;
  }

  // Types the OTP into whatever box the bank's own page is showing. Every
  // bank's page is different and none of them is ours, so this finds the box
  // by shape rather than by name, and says plainly when it cannot.
  //
  // `otp` is typed and dropped, exactly like the CVV.
  async submitOtp(otp: string): Promise<void> {
    try {
      await typeOtpIntoBankPage(this.page, otp, INSTAMART_ORIGIN);
    } catch (err) {
      // The shapes travel on the error, so that the worker's log still says
      // what the bank's page looked like when no box was found. Losing that
      // leaves the next attempt no wiser than this one.
      const shape = (err as { shape?: OtpPageShape }).shape;
      if (shape) this.otpPageShape = shape;
      throw err;
    }
  }

  // What the bank's page looked like when the code could not be placed:
  // shapes only, never a value. Read by the worker for the log.
  otpPageShape: { type: string | null; maxLength: number; visible: boolean; named: boolean }[] = [];

  // The verdict, from the vendor's own list of the household's orders.
  //
  // It cannot come from the order call. That call is answered BEFORE the
  // money moves - `PLACED` with `payment_status: PENDING` - and there is no
  // second one, so an earlier version of this read its own PENDING and
  // reported every successful payment as a failure. A household told their
  // payment failed when it did not pays twice.
  //
  // So afterwards the vendor is asked what became of the order. Three
  // answers, and the third is a real one: an order that is being shown and is
  // not dead went through; an order the vendor calls failed or cancelled did
  // not; and an order that cannot be found either way is UNKNOWN, which is
  // said as "we cannot tell, look in the app" and never as "it failed"
  // (design §9.4: degrade, never lie).
  async outcome(): Promise<{ orderId: string | null; paid: boolean; unknown: boolean }> {
    const until = Date.now() + ORDER_CONFIRM_WAIT_MS;
    let last: 'alive' | 'dead' | 'missing' = 'missing';
    while (Date.now() < until) {
      // The order list is asked for from inside the page, by a path relative
      // to wherever the page is. After the bank's page that is the bank, and
      // the path answers 404 there - so the first completed payment on this
      // account (order 249155386998331, 2026-09-23) polled the bank's site
      // for forty-five seconds and was reported "unconfirmed" while the
      // order sat in the household's own list. Come home first.
      await this.backOnOurOwnSite();
      last = await this.lookForOrder();
      if (last !== 'missing') break;
      await this.page.waitForTimeout(ORDER_CONFIRM_POLL_MS);
    }
    if (last === 'alive') return { orderId: this.orderId, paid: true, unknown: false };
    if (last === 'dead') return { orderId: this.orderId, paid: false, unknown: false };
    return { orderId: this.orderId, paid: false, unknown: true };
  }

  // On the vendor's own site, whatever page the payment left us on. The bank
  // and the gateway are other hosts, and nothing of the vendor's can be asked
  // from them.
  private async backOnOurOwnSite(): Promise<void> {
    let host = '';
    try {
      host = new URL(this.page.url()).hostname;
    } catch {
      host = '';
    }
    if (host.endsWith(new URL(INSTAMART_ORIGIN).hostname)) return;
    await this.page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS }).catch(() => undefined);
    await this.page.waitForTimeout(PAGE_SETTLE_MS);
  }

  // Is the order the worker placed in the household's own order list, and is
  // the vendor still calling it alive? Without an id there is nothing to look
  // for, and saying so is better than matching the newest order and hoping.
  private async lookForOrder(): Promise<'alive' | 'dead' | 'missing'> {
    if (!this.orderId) return 'missing';
    const r = await inPage(this.page, INSTAMART_RECENT_ORDERS_PATH).catch(() => null);
    if (!r || r.status !== 200) return 'missing';
    const status = statusOfOrder(r.body, this.orderId);
    if (status === null) return 'missing';
    return ORDER_DEAD_STATUSES.test(status) ? 'dead' : 'alive';
  }
}

// The vendor's own word for one order in its list of recent ones, found by
// id. Null when that order is not in the list at all.
export function statusOfOrder(body: string, orderId: string): string | null {
  let found: string | null = null;
  const walk = (v: unknown, depth: number): void => {
    if (found !== null || depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const id = o.order_id ?? o.orderId ?? o.order_no;
    if (id !== undefined && id !== null && String(id) === orderId) {
      const state = o.order_status ?? o.status ?? o.payment_status;
      found = typeof state === 'string' && state ? state : 'UNKNOWN';
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  try {
    walk(JSON.parse(body), 0);
  } catch {
    return null;
  }
  return found;
}

// Every box on the bank's page, by shape. Written as a plain string because
// tsx names inner arrow functions and the helper it adds does not exist
// inside the page.
const READ_BOXES = `(() => Array.prototype.map.call(document.querySelectorAll('input'), function (el, i) {
  var style = window.getComputedStyle(el);
  return {
    index: i,
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    id: el.getAttribute('id'),
    placeholder: el.getAttribute('placeholder'),
    ariaLabel: el.getAttribute('aria-label'),
    maxLength: el.maxLength,
    visible: el.getBoundingClientRect().width > 0 && style.visibility !== 'hidden' && style.display !== 'none' && el.getAttribute('type') !== 'hidden',
    disabled: el.disabled,
    readOnly: el.readOnly
  };
}))()`;

// A plain GET from inside the page, so the vendor's own signing applies.
async function inPage(page: Page, path: string): Promise<{ status: number; body: string }> {
  return page.evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}
