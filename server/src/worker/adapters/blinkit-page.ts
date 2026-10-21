// Blinkit's own cart and checkout, driven the way a person drives them.
//
// Why not the API, which this vendor does accept. Because there are two carts.
// `POST /v5/carts` fills the account's cart on the server, and the vendor's own
// checkout does not show it: filled through our call and then the cart page
// loaded fresh, it says "You don't have any items in your cart" (measured
// 2026-09-23). The CVV box lives on that checkout, so anything that wants to
// pay has to put items in the way the page does - by clicking ADD.
//
// The shapes below were recorded from the real site on 2026-09-23 and are all
// the page gives us: it renders controls as divs, so there is almost nothing
// to find by role.
//
//   search page   button "ADD" inside each product card
//   cart page     div "Proceed To Pay" - the text node is NOT the control, the
//                 handler sits several ancestors up
//   /checkout     div "Pay Now", disabled until a CVV is in
//   iframe        zomato.com/zpaykit/init holds the cards and the CVV box,
//                 which is an input[type=password]
import type { Frame, Locator, Page } from 'playwright-core';

import {
  BLINKIT_ORIGIN,
  BLINKIT_SEARCH_PATH,
  ORDER_CONFIRM_POLL_MS,
  ORDER_CONFIRM_WAIT_MS,
  CHECKOUT_SCREEN_TIMEOUT_MS,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
  ZPAYKIT_ORIGIN,
} from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import type { CapturedSession } from '../connect.js';
import { CartError } from './instamart-cart.js';
import type { Checkout, PaymentScreen, PayResult } from './checkout.js';
import { bankAmountFrom, isBankPage, typeOtpIntoBankPage, type OtpPageShape } from './instamart-checkout.js';
import { verdictForCart } from './blinkit-pay.js';
import { stubsFromList } from '../import/blinkit-parse.js';
import { addToCartItems, locationFor } from './blinkit-cart.js';
import type { CartLineResult, CartSession, CartWant, PaymentOption } from './instamart-cart.js';
import type { CartState, VendorAddress } from './instamart-catalog.js';
import { readStoredAddresses } from './blinkit.js';
import { setWithAlternatives } from './alternatives.js';

// How long to wait for a screen the vendor draws after a network round trip:
// the cart's Proceed bar, the checkout, the zpaykit frame.
const SCREEN_WAIT_MS = 25_000;
const STEP_MS = 800;

// How long the checkout gets to put a pressable Pay Now on screen after the
// code is typed. It redraws the row when the code is accepted, so the button
// that is there the instant the last digit lands is not the one to press.
const PAY_BUTTON_WAIT_MS = 20_000;
// How many controls are described when none of them could be pressed. Enough
// to see what the page became, few enough to stay readable.
const PAY_SHAPES_LOGGED = 25;

// Waiting for a search to finish drawing its cards: poll until the count
// stops growing. Short steps, because this runs once per item and the
// household is watching a spinner for the sum of them.
const CARD_POLL_MS = 400;
const CARD_POLLS = 30;

// How many ways of asking for one product before giving up on it. Each is a
// page load, and the household is waiting for the sum of them.
const SEARCH_TRIES = 3;

// How many controls are looked at when getting out of a payment. A bank page
// is small; this is a bound, not a target.
const CANCEL_CONTROLS_SCANNED = 400;

// The headers this vendor requires on a write to its cart, as its own error
// names them: app_client, app_version, device_id. They are read off the
// page's own requests rather than made up - they say which app and which
// device is speaking, and a wrong one is a different device.
const DEVICE_HEADERS = ['app_client', 'app_version', 'device_id'] as const;

// The bar at the foot of the cart. Its words change with the cart's state -
// "Proceed To Pay" on one cart, plain "Proceed" on another - so only the one
// word is required, and "Login to Proceed" is told apart from both because it
// means the opposite.
const PROCEED = /\bproceed\b/i;
const NOT_SIGNED_IN = /login to proceed/i;
const readyToPay = (text: string) => PROCEED.test(text) && !NOT_SIGNED_IN.test(text);

async function textOf(target: Page | Frame): Promise<string> {
  return (await target
    .locator('body')
    .innerText()
    .catch(() => '')).replace(/\s+/g, ' ');
}

// Wait until the cart is ready to be paid for, which is not the same as the
// word appearing: "Login to Proceed" contains it and means the opposite.
async function untilReady(page: Page, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (readyToPay(await textOf(page))) return true;
    await page.waitForTimeout(STEP_MS);
  }
  return false;
}

// Wait until the page says something, rather than for a fixed time.
async function until(target: Page | Frame, test: RegExp, ms = SCREEN_WAIT_MS): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (test.test(await textOf(target))) return true;
    await target.waitForTimeout(STEP_MS);
  }
  return false;
}

// The zpaykit frame, which is where the cards and the CVV box live.
export function zpaykitFrame(page: Page): Frame | null {
  return page.frames().find((f) => f.url().startsWith(ZPAYKIT_ORIGIN)) ?? null;
}

// How many things the page thinks are in its cart, read off its own cart
// button ("3 items ₹129"). The page's number, never ours.
export function cartCountFrom(text: string): number {
  const m = text.match(/(\d+)\s*items?\s*₹/i);
  return m ? Number(m[1]) : 0;
}

// The bar at the foot of the cart page carries the figure the checkout will
// actually ask for ("₹849 TOTAL Proceed To Pay").
export function totalFromCartPage(text: string): number | null {
  // The bar runs its words together - "₹122TOTALProceed" - so no space may
  // be required between the figure and the word.
  const m = text.match(/₹\s*([\d,]+)\s*TOTAL/i) ?? text.match(/₹([\d,]+)TOTAL/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The cards the payment sheet is offering, by the words on them. The tile
// reads "Amex American Express Card****** 1111Enter CVVCVV" - everything up
// to the masked digits is the name, and the digits are what tells two cards
// of the same bank apart.
// What the checkout says it will charge. Its own wording, not the cart's:
// "Pay Now ₹320", "Total ₹320", "To pay ₹320". Null when it states nothing,
// and the cart's figure is used then rather than a guess.
// Asked in order of how plainly each wording means "this is what you will be
// charged", not in the order the page happens to print them.
//
// This was one alternation with `total` inside it, and whichever label came
// first in the page text won. A checkout printing "Item Total ₹320 ... To Pay
// ₹255" therefore answered 320, and the household was asked to approve 320
// while the bank asked them for 255 (live, 2026-09-23, order 1000000005).
// Sixty-five rupees in their favour that time, and the same bug reads the
// other way just as easily.
//
// A bare "Total" is the last thing asked and is never accepted when the page
// has qualified it - an item total, a sub total, an MRP total and a bill
// total are all parts of a bill, not the bill.
const CHECKOUT_TOTAL_LABELS: RegExp[] = [
  /amount\s*payable\s*:?\s*₹\s*([\d,]+)/i,
  /(?:grand|order)\s*total\s*:?\s*₹\s*([\d,]+)/i,
  /to\s*pay\s*:?\s*₹\s*([\d,]+)/i,
  /pay\s*now\s*:?\s*₹\s*([\d,]+)/i,
  /₹\s*([\d,]+)\s*(?:to\s*pay|payable)/i,
];
// A word before "total" that makes it a part of the bill rather than the bill.
const PART_OF_BILL = /\b(item|items|sub|mrp|cart|bill|savings|saved|discount)\s*$/i;

export function totalFromCheckout(text: string): number | null {
  for (const label of CHECKOUT_TOTAL_LABELS) {
    const n = rupeesIn(text.match(label));
    if (n !== null) return n;
  }
  // Last: a plain "Total ₹255", but only where nothing in front of it says
  // which part of the bill it is.
  for (const m of text.matchAll(/\btotal\s*:?\s*₹\s*([\d,]+)/gi)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    if (PART_OF_BILL.test(before)) continue;
    const n = rupeesIn(m);
    if (n !== null) return n;
  }
  return null;
}

// The word on a control that means "stop this payment", and the words that
// only look like it. "Cancel order" on a vendor page is a different and much
// larger action, and "cancellation policy" is a link to read.
export function isCancelControl(label: string): boolean {
  const t = label.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > 40) return false;
  if (/policy|policies|terms|reason|history|learn more/.test(t)) return false;
  if (/cancel (?:the )?order/.test(t)) return false;
  return /\b(cancel|abort|go back|back to merchant|return to merchant)\b/.test(t);
}

// Press the way out of a payment, on whatever screen is in front of us.
//
// Never throws. The household has already said stop, and a page that offers
// no button is not a reason to leave them on a spinner.
async function pressCancel(target: Frame | Page): Promise<boolean> {
  const controls = target.locator('button, a, [role="button"], input[type="button"], input[type="submit"], div');
  const n = Math.min(await controls.count().catch(() => 0), CANCEL_CONTROLS_SCANNED);
  for (let i = 0; i < n; i++) {
    const one = controls.nth(i);
    const label = ((await one.innerText().catch(() => '')) || (await one.getAttribute('value').catch(() => '')) || '').toString();
    if (!isCancelControl(label)) continue;
    if (!(await one.isVisible().catch(() => false))) continue;
    await one.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => undefined);
    return true;
  }
  return false;
}

// One product as the store's search describes it.
export interface SearchHit {
  product_name?: unknown;
  unit?: unknown;
  inventory?: unknown;
}

// What a set of searches says about one wanted thing.
//
//   { query }       the store has it, and this wording found it
//   'out_of_stock'  the store lists it and has none
//   'not_listed'    this store does not carry it at all today
//   null            the store could not be asked, so NOTHING is concluded
//
// That last one is the important one. This decides whether the page is opened
// at all, so a bad answer read as "they do not sell it" would silently stop
// buying a household's food. An api that did not answer is never evidence.
export function verdictFromSearch(asked: { query: string; found: SearchHit[] | null }[], name: string): Verdict {
  let answered = false;
  let listed = false;
  for (const { query, found } of asked) {
    if (found === null) continue;
    answered = true;
    const core = coreName(name);
    const named = found.filter((i) => {
      const candidate = String(i.product_name ?? '');
      return matchesWanted(candidate, name) || (!!core && core !== name && matchesWanted(candidate, core));
    });
    if (!named.length) continue;
    listed = true;
    // `inventory` absent is not "none": only a number that says zero is.
    if (named.some((i) => i.inventory === undefined || Number(i.inventory) > 0)) return { query };
  }
  if (!answered) return null;
  return listed ? 'out_of_stock' : 'not_listed';
}

export type Verdict = 'not_listed' | 'out_of_stock' | { query: string } | null;

function rupeesIn(m: RegExpMatchArray | null): number | null {
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cardLabelsFrom(tiles: string[]): string[] {
  const out: string[] = [];
  for (const t of tiles) {
    const m = t.match(/^(.*?)\s*(\*+\s*\d{4})/);
    if (!m) continue;
    const label = `${m[1].trim()} ${m[2].replace(/\s+/g, '')}`.trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

// The product's name, out of everything else its card carries.
//
// A card reads "English Oven Sandwich White Bread400 g₹60ADD": the name, then
// the pack, the price and the button, with no spaces between them. Stored
// whole, that string is what the household is shown their cart contains, and
// what goes into prompted_adds as the thing they bought.
export function cleanProductName(cardText: string): string {
  let t = cardText.replace(/\s+/g, ' ').trim();
  // The vendor's own furniture at the front ("12 MINS", "SPONSORED").
  t = t.replace(/^\s*\d+\s*MINS?\s*/i, '').replace(/^\s*sponsored\s*/i, '');
  // Everything from the price, the button, or the pack onwards is not the
  // name. The pack is the first digit that begins a quantity, which is why
  // "Pack of 2" has to survive it - so a digit only ends the name when a
  // unit or a currency follows it.
  const cut = [
    t.search(/₹/),
    t.search(/\bADD\b/),
    // "Pack of 2" is packaging, not the product, and it runs into the size
    // after it: "Pack of 2" then "2 x 200 ml" reads as "Pack of 22 x 200 ml".
    // The name ends before it either way.
    t.search(/\bpack of\b/i),
    t.search(/\d+(\.\d+)?\s*(g|gm|gms|kg|ml|l|ltr|litre|pc|pcs|pieces?)\b/i),
    // `i >= 0`, not `> 0`: a search returns -1 for "not found" and 0 for
    // "at the start". Dropping 0 meant a fragment that is ONLY a pack or a
    // price - "500 ml", "₹29" - came back unchanged instead of empty, and
    // the cart page's pieces were read as product names.
  ].filter((i) => i >= 0);
  if (cut.length) t = t.slice(0, Math.min(...cut));
  // Whatever connector the cut left dangling.
  return t.replace(/[\s,\-–|]*(?:pack of|pack|of|x)?[\s,\-–|]*$/i, '').trim();
}

export class BlinkitPage {
  // The headers the page puts on its own api calls, overheard from them.
  //
  // Kept HERE rather than on the session, because the session is built after
  // the page has already booted and made most of its calls - listening from
  // there heard nothing at all, and our own call went out without them.
  private device: Record<string, string> = {};

  constructor(private readonly page: Page) {
    this.page.on('request', (r) => {
      if (!r.url().startsWith(BLINKIT_ORIGIN)) return;
      const h = r.headers();
      if (DEVICE_HEADERS.every((k) => h[k])) {
        this.device = Object.fromEntries(DEVICE_HEADERS.map((k) => [k, h[k]]));
      }
    });
  }

  // What to put on a call of ours so the vendor treats it as this page. Empty
  // until the page has made a call of its own.
  deviceHeaders(): Record<string, string> {
    return { ...this.device };
  }

  // ---------------------------------------------------------------- cart ---

  // Does this store sell the thing, and has it got any?
  //
  // Answered from the store's own search api, in one call, before any page is
  // opened. Three answers:
  //
  //   'not_listed'    nothing of that name here, so do not go looking
  //   'out_of_stock'  they sell it and have none, which the household wants
  //                   told immediately rather than after a minute of waiting
  //   { query }       found, with the wording that found it, so the page can
  //                   be opened once on a search that is known to return it
  //
  // `null` means the api could not be asked - a bad answer, a shape that has
  // changed - and then nothing is concluded from it: the page is driven the
  // long way, exactly as before. An api that quietly says "not listed" would
  // silently stop buying the household's food.
  async lookup(name: string, pack: string): Promise<Verdict> {
    const asked: { query: string; found: SearchHit[] | null }[] = [];
    for (const query of searchQueries(name)) {
      asked.push({ query, found: await this.searchApi(query) });
      // Found and in stock: no reason to keep asking.
      const so_far = verdictFromSearch(asked, name);
      if (typeof so_far === 'object' && so_far) return so_far;
    }
    return verdictFromSearch(asked, name);
  }

  // The store's own search, from inside its page. Null when it could not be
  // asked or could not be read - never an empty list, which would read as
  // "they do not sell it".
  private async searchApi(query: string): Promise<SearchHit[] | null> {
    const r = await this.call(`${BLINKIT_SEARCH_PATH}?q=${encodeURIComponent(query)}`, 'POST', { q: query }).catch(() => null);
    if (!r || r.status !== 200) return null;
    try {
      return addToCartItems(JSON.parse(r.body)) as unknown as SearchHit[];
    } catch {
      return null;
    }
  }

  // The vendor's own endpoints from inside its page, carrying what it
  // requires: the coordinates that decide the store, and the headers naming
  // the app and the device.
  async call(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.device };
    if (this.here) {
      headers.lat = String(this.here.lat);
      headers.lon = String(this.here.lng);
    }
    const args = JSON.stringify({ path, method, headers, body: body === undefined ? null : JSON.stringify(body) });
    return this.page.evaluate(`(async () => {
      const a = ${args};
      const r = await fetch(a.path, { method: a.method, credentials: 'include', headers: a.headers, body: a.body });
      return { status: r.status, body: await r.text() };
    })()`) as Promise<{ status: number; body: string }>;
  }

  // Where this browser is shopping. Set once, when the page is opened.
  here: { lat: number; lng: number } | null = null;

  // Put one product in the vendor's own cart, by clicking its own button.
  //
  // Returns what actually went in, because what goes in is the page's choice
  // among what it shows, and the household is told rather than trusted to
  // guess. Null means nothing matching was on the page.
  // Put one product in the cart, trying the ways a person would look for it.
  //
  // The household's own name for a thing is not always a query this store
  // answers. Four of seven lines came back "not listed" for products this
  // household buys HERE, under these exact names: the store's search simply
  // returns nothing for "Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1
  // Free", the way it returns nothing for any sentence. A person types
  // "aluminium foil".
  //
  // So the query is widened until the page shows something, while what
  // COUNTS as a match stays the household's own full name - a wider search
  // changes what is on screen, never what is allowed in the cart.
  // `known` is a query the store's own search has already answered for this
  // name, from `lookup`. Given one, the page is opened on it directly instead
  // of walking the widening ladder - the ladder exists for the case where we
  // do not know what the store will answer, and by then we do.
  async addByName(name: string, pack: string, known?: string): Promise<{ name: string; pack: string; price: number | null } | null> {
    // The name without the vendor's promotion and its asides, as a second
    // thing to accept: the store's card for the same product often carries
    // neither, and requiring "buy 1 get 1 free" to appear on it refused the
    // household's own foil.
    const core = coreName(name);
    const names = core && core !== name ? [name, core] : [name];
    const queries = known ? [known, ...searchQueries(name).filter((q) => q !== known)] : searchQueries(name);
    for (const query of queries) {
      const got = await this.addBySearch(query, names, pack);
      if (got) return got;
    }
    return null;
  }

  private async addBySearch(
    query: string,
    names: string[],
    pack: string,
  ): Promise<{ name: string; pack: string; price: number | null } | null> {
    // `domcontentloaded`, not `load`: `load` waits for every product photo on
    // a page of them, which is seconds an item and nothing this needs - the
    // wait that matters is for the cards, and it is right below. Filling five
    // things took a minute and the household watched all of it.
    await this.page.goto(`${BLINKIT_ORIGIN}/s/?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
    // Wait for the results, rather than for a fixed time. Read too early the
    // page has no cards at all and the answer is "not listed" about a product
    // the store sells - which it gave for the household's own bread, having
    // found it a minute earlier.
    //
    // Then wait for the count to STOP growing, rather than a flat three
    // seconds. The page draws its first row quickly and the rest in a burst,
    // so the fixed wait was far too long on most searches and would have been
    // too short on a slow one.
    const ready = this.page.getByRole('button', { name: /^add$/i });
    let drawn = 0;
    for (let t = 0; t < CARD_POLLS; t++) {
      const n = await ready.count().catch(() => 0);
      if (n && n === drawn) break;
      drawn = n;
      await this.page.waitForTimeout(CARD_POLL_MS);
    }

    // Every card the search drew, with its own ADD.
    //
    // Found through the accessibility tree, not `querySelectorAll('button')`:
    // this site renders its controls as divs, so a tag query finds none of
    // them at all. The card's words are then read by walking up from each
    // ADD until there is enough text to be a product.
    const adds = this.page.getByRole('button', { name: /^add$/i });
    const count = await adds.count();
    const cards: { at: number; text: string }[] = [];
    for (let i = 0; i < count; i++) {
      const text = (await adds
        .nth(i)
        .evaluate((el) => {
          let card: HTMLElement = el as HTMLElement;
          for (let up = 0; up < 8 && card.parentElement; up++) {
            card = card.parentElement;
            if ((card.textContent || '').replace(/\s+/g, ' ').trim().length > 25) break;
          }
          return (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        })
        .catch(() => '')) as string;
      if (text) cards.push({ at: i, text });
    }
    const before = cartCountFrom(await textOf(this.page));
    // Closest first: the household's own pack, then the name with fewest
    // words the vendor added of its own. The full name is tried before the
    // shortened one, so the widening never costs a better match.
    let scored: { at: number; text: string; packed: boolean; extra: number }[] = [];
    let matchedOn = names[0];
    for (const want of names) {
      scored = cards
        .filter((c) => matchesWanted(c.text, want))
        .map((c) => ({ ...c, packed: samePack(c.text, pack), extra: extraWords(c.text, want) }))
        .sort((a, b) => Number(b.packed) - Number(a.packed) || a.extra - b.extra);
      if (scored.length) {
        matchedOn = want;
        break;
      }
    }
    if (process.env.BLINKIT_DEBUG) {
      console.log(`  [debug] "${query}" for "${names[0]}": ${cards.length} cards, ${scored.length} match`);
      for (const c of cards.slice(0, 4)) console.log(`     ${matchesWanted(c.text, matchedOn) ? 'MATCH' : '  no '} ${c.text.slice(0, 90)}`);
    }
    if (!scored.length) return null;

    // Some products open a pack chooser instead of adding, which has its own
    // ADD on top.
    for (const pick of scored.slice(0, 3)) {
      const got = { name: cleanProductName(pick.text), pack: packFrom(pick.text) || pack, price: priceFrom(pick.text) };
      await adds.nth(pick.at).click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => undefined);
      if (await this.cartGrew(before)) return got;

      const chooser = this.page.locator('[role="dialog"], [class*="Drawer"], [class*="Sheet"], [class*="Modal"]').getByRole('button', { name: /^add$/i });
      if (await chooser.count()) {
        await chooser.first().click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => undefined);
        if (await this.cartGrew(before)) return got;
      }
    }
    return null;
  }

  private async cartGrew(before: number): Promise<boolean> {
    for (let t = 0; t < 6; t++) {
      await this.page.waitForTimeout(600);
      if (cartCountFrom(await textOf(this.page)) > before) return true;
    }
    return false;
  }

  // One more of something already in the cart, through the card's own plus.
  async addMore(productText: string): Promise<boolean> {
    const before = cartCountFrom(await textOf(this.page));
    const where = (await this.page.evaluate(`(() => {
      const want = ${JSON.stringify(productText.slice(0, 40))};
      for (const el of document.querySelectorAll('div, span, button')) {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t !== '+') continue;
        let card = el;
        for (let up = 0; up < 8 && card.parentElement; up++) {
          card = card.parentElement;
          if ((card.textContent || '').includes(want.slice(0, 20))) {
            const r = el.getBoundingClientRect();
            if (r.width > 8 && r.height > 8) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }
      return null;
    })()`)) as { x: number; y: number } | null;
    if (!where) return false;
    await this.page.mouse.click(where.x, where.y).catch(() => undefined);
    return this.cartGrew(before);
  }

  // What the vendor's own cart page says is in it, and what it will charge.
  // Go to the vendor's own cart page, unless already there. Every reader
  // below wants that page: read from wherever the browser happened to be -
  // the search page, after the last thing was added - the bill is all nulls,
  // the total is null, and a cart with things in it looks worth nothing.
  async showCart(): Promise<void> {
    if (/\/cart/.test(this.page.url())) return;
    const cartButton = this.page.getByText(/\d+\s*items?\s*₹/i).first();
    if (await cartButton.count()) {
      await cartButton.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => undefined);
      await this.page.waitForTimeout(PAGE_SETTLE_MS);
    }
    if (!/\/cart/.test(this.page.url())) {
      await this.page.goto(`${BLINKIT_ORIGIN}/cart`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
    }
    // The bill is drawn after the address is checked, so wait for it rather
    // than reading an empty frame.
    for (let t = 0; t < 20; t++) {
      if (/sub total|bill details|proceed/i.test(await textOf(this.page))) return;
      await this.page.waitForTimeout(STEP_MS);
    }
  }

  // How many things the vendor says are in its cart.
  //
  // Asked in both the ways the page says it - "Shipment of 3 items" on the
  // cart itself, and "3 items ₹320" on the button that opens it - and the
  // larger is taken, because each is sometimes drawn before the other. This
  // is a COUNT and needs no product name to be legible, which is why the
  // decision about whether a cart survived is made on it.
  async cartCount(): Promise<number> {
    await this.showCart();
    const text = await textOf(this.page);
    const shipments = [...text.matchAll(/shipment of (\d+)\s*items?/gi)].map((m) => Number(m[1]));
    return Math.max(shipments.reduce((a, b) => a + b, 0), cartCountFrom(text));
  }

  async readCart(): Promise<{
    lines: { name: string; quantity: number }[];
    itemTotal: number | null;
    delivery: number | null;
    other: number | null;
    toPay: number | null;
    eta: string | null;
  }> {
    await this.showCart();
    const text = await textOf(this.page);
    const money = (re: RegExp): number | null => {
      const m = text.match(re);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const lines = (await this.page.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('[class*="CartProduct"], [class*="ProductCard"]')) {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t && t.length < 140) out.push(t);
      }
      return out.slice(0, 40);
    })()`).catch(() => [])) as string[];
    // How many things the vendor says are in the cart, from its own words:
    // "Shipment of 3 items", once per shipment. A DOM selector counted ten
    // for a cart of one, because the page carries recommendations built from
    // the same components - and that count is checked against the payment
    // screen before anything is paid, so an inflated one stops a real order.
    const shipments = [...text.matchAll(/shipment of (\d+)\s*items?/gi)].map((m) => Number(m[1]));
    const counted = shipments.reduce((a, b) => a + b, 0);
    // The same product matches several nested elements, so the raw list
    // repeats: a milk-and-curd cart read as milk, milk. Unique names, in the
    // order the page draws them.
    const unique: string[] = [];
    for (const t of lines) {
      const name = cleanProductName(t);
      // A product is named with more than one word. The page's own controls
      // leave fragments behind - "U15" is a quantity stepper - and they are
      // not things in the cart.
      if (name && name.includes(' ') && !unique.includes(name)) unique.push(name);
    }
    // The COUNT is the vendor's and is what the payment screen is checked
    // against, so it stands whatever could be named. The names are read as
    // well as they can be and are only ever shown; what the household is told
    // went in comes from the adding, not from here.
    const named = counted ? Array.from({ length: counted }, (_, i) => unique[i] ?? '') : unique;
    return {
      lines: named.map((t) => ({ name: t.slice(0, 70), quantity: 1 })),
      itemTotal: money(/Sub total\s*₹\s*([\d,]+)/i),
      delivery: money(/Delivery charge\s*₹\s*([\d,]+)/i),
      other: money(/Handling charge\s*₹\s*([\d,]+)/i),
      toPay: totalFromCartPage(text),
      eta: text.match(/Delivery in ([^.]{1,20}?minutes)/i)?.[1] ?? null,
    };
  }

  // ------------------------------------------------------------ checkout ---

  // Open the vendor's own checkout from its cart page.
  //
  // "Proceed To Pay" is a div and the text node is not the control: the
  // handler sits several ancestors up, so this climbs until the page moves.
  // It stops the moment it does, so it never presses further than it must.
  async openCheckout(): Promise<{ total: number | null; cards: string[] }> {
    await this.showCart();
    // The figure the cart page carries, read BEFORE pressing Proceed. It was
    // read afterwards, on the checkout, where that text does not exist - so
    // the total came back null, and a total that cannot be read stops the
    // order as "the price changed".
    const cartTotal = totalFromCartPage(await textOf(this.page));

    // The bar sits at the foot of a long page and the site draws it late.
    // Scrolling is what a person does and it is what makes it appear.
    //
    // It is found and pressed in the DOM rather than through a text locator.
    // The control is a div whose own text is "Proceed" with an icon glyph
    // after it, and the handler sits on an ancestor - so this walks up from
    // the text and clicks each one until the page moves. A locator found
    // nothing clickable here at all.
    // Where the control is, and whether it is the signed-out one. The click
    // itself is done with the real mouse below: a DOM `el.click()` bubbles
    // but the site's handler ignores it, and pressing every ancestor in the
    // DOM did nothing at all. A mouse click at the control's own coordinates
    // is what a person does and is what it answers to.
    const findProceed = async (): Promise<{ x: number; y: number } | 'login' | null> =>
      (await this.page.evaluate(`(() => {
        const found = [];
        for (const el of document.querySelectorAll('div, span, button, a')) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 40 || !/proceed/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          if (!(r.width > 20 && r.height > 10)) continue;
          if (r.bottom < 0 || r.top > innerHeight) continue;
          found.push({ len: t.length, text: t, x: r.x + r.width / 2, y: r.y + r.height / 2 });
        }
        if (!found.length) return null;
        if (found.some((f) => /login/i.test(f.text))) return 'login';
        found.sort((a, b) => a.len - b.len);
        return { x: found[0].x, y: found[0].y };
      })()`)) as { x: number; y: number } | 'login' | null;

    const moved = async () => this.page.url().includes('/checkout') || !!zpaykitFrame(this.page);
    const stop = Date.now() + 45_000;
    let pressed = false;
    while (Date.now() < stop && !(await moved())) {
      const where = await findProceed();
      if (where === 'login') throw new CartError('unauthorized');
      if (where) {
        await this.page.mouse.click(where.x, where.y).catch(() => undefined);
        pressed = true;
        await this.page.waitForTimeout(PAGE_SETTLE_MS);
        if (await moved()) break;
      }
      await this.page.mouse.wheel(0, 1000).catch(() => undefined);
      await this.page.waitForTimeout(STEP_MS);
    }
    if (!(await moved())) {
      const said = await textOf(this.page);
      if (NOT_SIGNED_IN.test(said)) throw new CartError('unauthorized');
      // A cart with things in it and no way to check out is not an empty
      // cart and not a broken page: this vendor simply will not take an
      // order this small. Measured - a 29 rupee cart drew no bar where an
      // 849 rupee one did.
      const hasItems = /shipment of|bill details|sub total/i.test(said);
      throw new CartError(hasItems ? 'cart_too_small' : pressed ? 'no_payment_screen' : 'empty_cart');
    }

    const frame = await this.waitForZpaykit();
    // The checkout's own figure where it states one, and the cart's
    // otherwise. The checkout is what will be charged, so it wins.
    const onCheckout = totalFromCheckout(await textOf(this.page));
    return { total: onCheckout ?? cartTotal, cards: cardLabelsFrom(await this.cardTiles(frame)) };
  }

  private async waitForZpaykit(): Promise<Frame> {
    const stop = Date.now() + SCREEN_WAIT_MS;
    while (Date.now() < stop) {
      const f = zpaykitFrame(this.page);
      if (f) return f;
      await this.page.waitForTimeout(STEP_MS);
    }
    throw new CartError('no_payment_screen');
  }

  // The household's saved cards, once the payment frame has drawn them.
  //
  // Waiting for the WORD "card" was not waiting for the cards: the frame says
  // "Add new card" long before the saved ones arrive, so the wait passed, no
  // tile existed yet, and the household was told their own card was "not on
  // the payment screen any more" (2026-09-23). The same run had found it a
  // few minutes earlier - it was a race, and a race about which card gets
  // charged is not one to leave in.
  //
  // So this waits for the tiles themselves, and settles for however many
  // exist once they stop arriving.
  private async cardTiles(frame: Frame): Promise<string[]> {
    let last: string[] = [];
    const stop = Date.now() + SCREEN_WAIT_MS;
    while (Date.now() < stop) {
      const now = await this.readCardTiles(frame);
      // Drawn, and no longer changing.
      if (now.length && now.length === last.length) return now;
      last = now;
      await frame.waitForTimeout(STEP_MS).catch(() => undefined);
    }
    return last;
  }

  private async readCardTiles(frame: Frame): Promise<string[]> {
    return (await frame.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('[class*="CardTile__Container"]')) {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) out.push(t.slice(0, 120));
      }
      return out;
    })()`).catch(() => [])) as string[];
  }

  // The card the household named. Clicking its tile is what opens the CVV box
  // underneath it, so everything after this is read from inside that tile.
  async chooseCard(label: string): Promise<void> {
    const frame = await this.waitForZpaykit();
    const digits = label.match(/(\d{4})\s*$/)?.[1] ?? '';
    const tiles = await this.cardTiles(frame);
    const wanted = tiles.findIndex((t) => (digits ? t.includes(digits) : t.toLowerCase().includes(label.toLowerCase())));
    if (wanted < 0) throw new CartError('card_not_found');
    const tile = frame.locator('[class*="CardTile__Container"]').nth(wanted);
    await tile.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS }).catch(() => undefined);
    await this.page.waitForTimeout(PAGE_SETTLE_MS);
  }

  // Is the sheet asking for a code? The box is a password input inside the
  // zpaykit frame, and it appears only once a card is chosen.
  async cvvNeeded(): Promise<boolean> {
    const frame = zpaykitFrame(this.page);
    if (!frame) return false;
    return (await frame.locator('input[type="password"]').count().catch(() => 0)) > 0;
  }

  // What the bank's own page says it is about to take. Null when it does not
  // say, which is not an error: many do not.
  async bankTotal(): Promise<number | null> {
    for (const f of this.page.frames()) {
      if (!isBankPage(f.url(), BLINKIT_ORIGIN)) continue;
      const found = bankAmountFrom(await textOf(f));
      if (found !== null) return found;
    }
    return isBankPage(this.page.url(), BLINKIT_ORIGIN) ? bankAmountFrom(await textOf(this.page)) : null;
  }

  // Did the bank put up its own page? Answered by the frames that appear
  // after Pay, judged by host and never by the whole url - an ad pixel
  // carries the same words in its query string.
  async waitForBank(ms = SCREEN_WAIT_MS): Promise<boolean> {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      for (const f of this.page.frames()) if (isBankPage(f.url(), BLINKIT_ORIGIN)) return true;
      if (isBankPage(this.page.url(), BLINKIT_ORIGIN)) return true;
      await this.page.waitForTimeout(STEP_MS);
    }
    return false;
  }

  // Type the code and press the button that spends the money.
  //
  // `cvv` is typed and dropped. It is never stored on this object, never
  // logged and never part of an error. The value is read back before Pay is
  // pressed, because a half-typed code is a decline on an order the vendor
  // has already made.
  async pay(cvv: string | null): Promise<{ pressedAt: Date }> {
    const frame = await this.waitForZpaykit();
    if (cvv !== null) {
      const box = frame.locator('input[type="password"]').first();
      if (!(await box.count())) throw new CartError('no_cvv_box');
      await box.fill(cvv, { timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
      if ((await box.inputValue().catch(() => '')) !== cvv) throw new CartError('cvv_not_accepted');
    }

    // Pay Now lives in the PARENT page, not in the zpaykit frame, and is
    // disabled until the code is in - which is how the page says it is ready.
    // It is also drawn more than once: the checkout keeps a button for every
    // payment method it offers and hides the ones whose row is closed. The
    // first in the DOM was a hidden one, so the click spent thirty seconds on
    // "element is not visible" and the order never happened (2026-09-23,
    // with the CVV already typed). So the button is found by being ON SCREEN,
    // and the page is given time to enable it after the code goes in.
    const button = await this.payButton();
    if (!button) {
      // The shapes travel on the error, the way the bank page's boxes do, so
      // the worker's log says what the page HAD when nothing could be pressed.
      const err = new CartError('no_pay_button');
      (err as CartError & { shape?: unknown }).shape = await this.payShapes();
      throw err;
    }
    const pressedAt = new Date();
    await button.click({ timeout: CHECKOUT_SCREEN_TIMEOUT_MS });
    return { pressedAt };
  }

  // The Pay Now the household can see and press, or null.
  //
  // Visible AND not marked off. A div carries no `disabled` attribute, so
  // this vendor says "not yet" with aria-disabled or a class, and the wait is
  // for the page to catch up with the code that was just typed.
  private async payButton(): Promise<Locator | null> {
    const until = Date.now() + PAY_BUTTON_WAIT_MS;
    let seen: Locator | null = null;
    while (Date.now() < until) {
      for (const group of this.payCandidates()) {
        const n = await group.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const one = group.nth(i);
          if (!(await one.isVisible().catch(() => false))) continue;
          seen = one;
          if (await isPressable(one)) return one;
        }
      }
      await this.page.waitForTimeout(STEP_MS);
    }
    // On screen the whole time and never enabled: pressing it is still the
    // household's instruction, and the vendor refuses far more safely than a
    // silent give-up does.
    return seen;
  }

  private payCandidates(): Locator[] {
    return [
      this.page.locator('[class*="Zpayments__Button"]').filter({ hasText: /pay now/i }),
      this.page.locator('[class*="Button"]').filter({ hasText: /^\s*pay now/i }),
      this.page.getByText(/^pay now$/i),
    ];
  }

  // What WAS on the page, when nothing could be pressed. Shapes only: this
  // screen holds a card number and a code, and neither is ever logged.
  private async payShapes(): Promise<{ text: string; visible: boolean }[]> {
    const out: { text: string; visible: boolean }[] = [];
    const all = this.page.locator('[class*="Button"], button, [role="button"]');
    const n = Math.min(await all.count().catch(() => 0), PAY_SHAPES_LOGGED);
    for (let i = 0; i < n; i++) {
      const one = all.nth(i);
      out.push({
        text: ((await one.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 40),
        visible: await one.isVisible().catch(() => false),
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------- matching --
//
// Which of the vendor's results is the thing this household buys. Two ways of
// getting this wrong have already put the wrong food in a real cart.
//
// Taking the cheapest thing under the word put a ten rupee pineapple sweet
// fill BREAD ROLL in a cart that asked for bread. Requiring the household's
// name as an unbroken phrase then refused "English Oven Sandwich WHITE Bread"
// for a cart that asked for "English Oven Sandwich Bread" - the vendor simply
// names it with one more word - so the order had nothing to pay for.
//
// The rule that survives both: every word of the wanted name must be there,
// AND the head noun - the last word, what the thing IS - must be where the
// candidate ends. "English Oven Sandwich White Bread" ends in bread and is
// the same bread; "Amul Fresh Butter Cookies" ends in cookies and is not
// butter, however many of its words match.
const STOP_WORDS = new Set(['and', 'the', 'with', 'for', 'of', 'in', 'a', 'an', 'pack', 'combo']);
const PACK_WORD = /^\d+(\.\d+)?(g|gm|gms|kg|ml|l|ltr|litre|pc|pcs|pieces?|x\d+)?$/;
// Words a product card carries that are not the product: the vendor's own
// furniture. Left in, "ADD" becomes the head noun of every card on the page.
const CARD_WORDS = new Set(['add', 'mins', 'min', 'off', 'options', 'sponsored', 'showing', 'results', 'item', 'items']);
// Units standing on their own, once a quantity has been split off them. Left
// in, "ml" is the last word of "Amul Taaza Toned Milk 500 ml" and the head
// noun test looks at the wrong word.
const UNIT_WORDS = new Set(['ml', 'kg', 'gm', 'gms', 'ltr', 'litre', 'pc', 'pcs', 'piece', 'pieces']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/₹\s*[\d,.]+/g, ' ')
    // The cards run words into numbers - "Bread400 g", "Cookies200 g" - so a
    // letter meeting a digit is a word boundary. Without this the head noun
    // of "... White Bread400" is "bread400" and matches nothing.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9%. ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !CARD_WORDS.has(w) && !UNIT_WORDS.has(w) && !PACK_WORD.test(w));
}

// The product without the vendor's promotion and its asides.
//
// "Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free" is a product name
// with an advertisement stuck to it. The advertisement is not on the other
// store's card for the same foil, and is not in anybody's search.
export function coreName(name: string): string {
  return name
    // Everything from a dash that introduces an offer.
    .replace(/\s*[-–—]\s*(buy|get|save|free|offer|combo|pack of)\b.*$/i, '')
    // Asides the vendor adds: pack maths, "(Frozen)", "(Boneless)".
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// What to type into the store's search box, narrowest first.
//
// Exported for its tests: a query that finds nothing is reported to the
// household as "the store does not sell this", which is a lie about a
// product they bought there last week.
export function searchQueries(name: string): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    const t = q.trim();
    if (t && !out.includes(t) && out.length < SEARCH_TRIES) out.push(t);
  };
  add(name);
  add(coreName(name));
  // Brand and head noun: what a person types. "Freshwrapp ... Foil" rather
  // than the whole label.
  const w = words(coreName(name) || name);
  if (w.length > 2) add(`${w[0]} ${w[w.length - 1]}`);
  // The thing itself, with the one word in front of it.
  if (w.length > 1) add(w.slice(-2).join(' '));
  return out;
}

// Is this candidate the wanted product? Exported for its tests: it decides
// what a household is charged for, and it cannot be tried against a store on
// demand.
export function matchesWanted(candidate: string, wantedName: string): boolean {
  const want = words(wantedName);
  const have = words(candidate);
  if (!want.length || !have.length) return false;
  if (!want.every((w) => have.includes(w))) return false;
  // The head noun - what the thing IS - has to be what the candidate's name
  // ENDS with. Allowing it one word earlier let "Amul Fresh Butter Cookies"
  // pass for butter, because butter is then the second to last word. Ending
  // in cookies means it is cookies.
  return have[have.length - 1] === want[want.length - 1];
}

// How far a candidate is from the wanted name: fewer extra words is closer.
export function extraWords(candidate: string, wantedName: string): number {
  return Math.max(0, words(candidate).length - words(wantedName).length);
}

function samePack(text: string, pack: string): boolean {
  if (!pack) return false;
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, '').replace(/ltr|litre|liter/g, 'l').replace(/gm|gms|gram|grams/g, 'g');
  return norm(text).includes(norm(pack));
}

// The pack the card is offering ("400 g", "2 x 200 ml"), so the cart shows
// what was actually bought rather than the pack that was asked for.
export function packFrom(text: string): string {
  const m = text.match(/(\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?(?:g|gm|gms|kg|ml|l|ltr|litre|pc|pcs|pieces?))\b/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// Is this control offering itself to be pressed? A div has no `disabled`
// attribute, so "no" is said with aria-disabled, a class, or the pointer
// being turned off.
async function isPressable(one: Locator): Promise<boolean> {
  if ((await one.getAttribute('disabled').catch(() => null)) !== null) return false;
  if ((await one.getAttribute('aria-disabled').catch(() => null)) === 'true') return false;
  const klass = (await one.getAttribute('class').catch(() => '')) ?? '';
  if (/disabled|inactive/i.test(klass)) return false;
  const events = await one.evaluate((el) => getComputedStyle(el as Element).pointerEvents).catch(() => 'auto');
  return events !== 'none';
}

function priceFrom(text: string): number | null {
  const m = text.match(/₹\s*([\d,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}


// A browser holding this household's session, for driving the vendor's own
// pages.
//
// The bootstrap runs ONCE, not on every load, and that is the whole point.
// The cart adapter re-applies the session and clears `merchant` on each
// navigation so the store is resolved afresh - which is right for a cart
// filled by API, and fatal here: it took the page's own cart with it every
// time, so a cart filled on the search page was empty by the time the cart
// page opened. Here the coordinates are set once, the store resolves once,
// and nothing touches storage again.
export async function openBlinkitPage(
  session: CapturedSession,
  address: VendorAddress,
  launch: () => Promise<HeadlessBrowser> = () => launchHeadless(),
): Promise<{ page: Page; blinkit: BlinkitPage; close: () => Promise<void> }> {
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
    await context.addInitScript(
      `if (location.origin === ${JSON.stringify(BLINKIT_ORIGIN)} && !localStorage.getItem('dm_ready')) {
         const s = ${JSON.stringify(session.localStorage)};
         for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
         localStorage.setItem('location', ${JSON.stringify(locationFor(address))});
         localStorage.removeItem('merchant');
         localStorage.setItem('dm_ready', '1');
       }`,
    );
    const page = await context.newPage();
    // Built BEFORE the first navigation, because its constructor is what
    // listens for the headers the page puts on its own api calls. Built
    // afterwards it heard nothing: by then the page had made them all.
    const blinkit = new BlinkitPage(page);
    // Which store its api calls are about. The coordinates decide it, and
    // without them the vendor answers 400.
    blinkit.here = { lat: address.lat, lng: address.lng };
    await page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
    await page.waitForTimeout(PAGE_SETTLE_MS * 2);
    return { page, blinkit, close: () => hb.close() };
  } catch (err) {
    await hb.close();
    throw err;
  }
}


// Blinkit's checkout, behind the interface `pay.ts` already trusts.
//
// Everything it does is the vendor's own screen: its Proceed, its card tile,
// its CVV box, its Pay Now. The API chain that was mapped first cannot be
// used for this - its cart is invisible to this checkout - so this is the one
// that can actually take a household's money, and the one the CVV lives on.
export class BlinkitPageCheckout implements Checkout {
  private orderIdSeen: string | null = null;
  private pressed = false;

  constructor(
    private readonly bk: BlinkitPage,
    private readonly page: Page,
    // For the verdict afterwards, which is matched by the cart rather than by
    // any id this screen shows (design Appendix A).
    private readonly cartId: string | null,
    private readonly lines: number | null,
    private readonly addressLabel: string | null,
    private readonly blinkitCall: (path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown) => Promise<{ status: number; body: string }>,
  ) {}

  // An order id the moment one exists. The vendor mints it at
  // `zomato_payment_hash`, which its own page calls once Pay is pressed, so
  // it is overheard rather than asked for.
  get placedOrderId(): string | null {
    return this.orderIdSeen;
  }

  otpPageShape: OtpPageShape = [];

  async open(): Promise<PaymentScreen> {
    // Watch for the id on the wire from here on: after Pay is pressed an
    // order may exist whatever else happens.
    this.page.on('response', (r) => {
      if (!/zomato_payment_hash/i.test(r.url())) return;
      void r
        .text()
        .then((body) => {
          const m = body.match(/"order_id"\s*:\s*"?(\d+)"?/);
          if (m && !this.orderIdSeen) this.orderIdSeen = m[1];
        })
        .catch(() => undefined);
    });
    const screen = await this.bk.openCheckout();
    return {
      total: screen.total,
      items: this.lines,
      address: this.addressLabel,
      cards: screen.cards,
      // Blinkit's own checkout offers this account no pay-on-delivery, and
      // claiming one that is not there would strand an order unpaid.
      onDelivery: false,
    };
  }

  async chooseCard(label: string): Promise<void> {
    await this.bk.chooseCard(label);
  }

  async cvvNeeded(): Promise<boolean> {
    return this.bk.cvvNeeded();
  }

  async pay(cvv: string | null): Promise<PayResult> {
    const { pressedAt } = await this.bk.pay(cvv);
    this.pressed = true;
    // The bank's own page arrives in this same tab, through the gateway's
    // redirect. Whether it asked is what decides if an OTP is wanted.
    const bankAsked = await this.bk.waitForBank();
    // What the bank itself says it is taking, read while its page is up. The
    // checkout's figure is history by now: the order exists and the vendor
    // may have changed the cart making it.
    const bankTotal = bankAsked ? await this.bk.bankTotal() : null;
    return { pressedAt, orderId: this.orderIdSeen, paid: false, bankAsked, bankTotal };
  }

  async payOnDelivery(): Promise<PayResult> {
    throw new CartError('internal');
  }

  async submitOtp(otp: string): Promise<void> {
    try {
      await typeOtpIntoBankPage(this.page, otp, BLINKIT_ORIGIN);
    } catch (err) {
      const shape = (err as { shape?: OtpPageShape }).shape;
      if (shape) this.otpPageShape = shape;
      throw err;
    }
  }

  // Get out of a payment the household has asked to stop.
  //
  // The order already exists - the vendor makes it before the money moves -
  // so nothing here undoes anything. It presses the way out that the screen
  // in front of us offers, which is what a person does: on the bank's own
  // page that is its Cancel, and it hands the gateway a failure rather than
  // leaving it waiting for a code that will never come.
  //
  // Chosen by SHAPE and by word, on the bank's page and then ours, and it
  // never throws: the household has already said stop, and not finding a
  // button is not a reason to leave them waiting on a spinner.
  async cancelPayment(): Promise<boolean> {
    for (const target of [...this.page.frames(), this.page]) {
      const url = 'url' in target ? target.url() : this.page.url();
      const onBank = isBankPage(url, BLINKIT_ORIGIN);
      if (!onBank) continue;
      if (await pressCancel(target as Frame | Page)) return true;
    }
    // Not on the bank's page, or it offered nothing: the vendor's own
    // checkout is the next best place to leave from.
    return pressCancel(this.page);
  }

  // Matched by the CART, never by an order id this screen showed: the
  // payment's id and the one the vendor's own list uses are different numbers
  // (design Appendix A).
  async outcome(): Promise<{ orderId: string | null; paid: boolean; unknown: boolean }> {
    if (!this.pressed) return { orderId: this.orderIdSeen, paid: false, unknown: false };
    if (!this.cartId) return { orderId: this.orderIdSeen, paid: false, unknown: true };
    // Asked more than once, from the vendor's own site. The order list is
    // fetched from inside the page by a relative path, and after the bank's
    // page that path points at the bank; and the vendor takes a moment to
    // list a just-paid order. One question, asked from the wrong site, was
    // how Instamart's first completed payment came back "unconfirmed" with
    // the order sitting in the household's list (2026-09-23).
    const until = Date.now() + ORDER_CONFIRM_WAIT_MS;
    let last: { orderId: string | null; paid: boolean; unknown: boolean } = { orderId: this.orderIdSeen, paid: false, unknown: true };
    while (Date.now() < until) {
      await this.backOnOurOwnSite();
      last = await this.lookForOrder();
      if (!last.unknown) return last;
      await this.page.waitForTimeout(ORDER_CONFIRM_POLL_MS);
    }
    return last;
  }

  private async lookForOrder(): Promise<{ orderId: string | null; paid: boolean; unknown: boolean }> {
    try {
      const r = await this.blinkitCall('/v1/layout/order_history', 'POST', {});
      if (r.status !== 200) return { orderId: this.orderIdSeen, paid: false, unknown: true };
      const verdict = verdictForCart(stubsFromList(JSON.parse(r.body)), this.cartId!);
      if (verdict.state !== 'placed') return { orderId: this.orderIdSeen, paid: false, unknown: true };
      const word = verdict.order.status.toUpperCase();
      const alive = ['DELIVERED', 'ENROUTE', 'ARRIVING', 'PLACED', 'CONFIRMED', 'PACKING', 'ACTIVE'].includes(word);
      const dead = ['CANCELLED', 'CANCELED', 'FAILED', 'REFUNDED'].includes(word);
      return { orderId: verdict.order.orderId, paid: alive, unknown: !alive && !dead };
    } catch {
      return { orderId: this.orderIdSeen, paid: false, unknown: true };
    }
  }

  // On the vendor's own site, whatever page the payment left us on.
  private async backOnOurOwnSite(): Promise<void> {
    let host = '';
    try {
      host = new URL(this.page.url()).hostname;
    } catch {
      host = '';
    }
    if (host.endsWith(new URL(BLINKIT_ORIGIN).hostname)) return;
    await this.page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS }).catch(() => undefined);
    await this.page.waitForTimeout(PAGE_SETTLE_MS);
  }
}


// Blinkit as a cart the app can fill AND pay for, driven through the vendor's
// own pages (design §19 stages 1-3).
//
// This replaces the API cart session for every job that might be paid for.
// The API one is faster and its matching is better tested, but the cart it
// fills is invisible to the vendor's own checkout, so nothing filled that way
// can ever be paid for from here. A cart nobody can pay for and nobody can
// see is no use to a household.
export class BlinkitPageSession implements CartSession {
  address: VendorAddress | null;
  private checkoutSession: BlinkitPageCheckout | null = null;
  private cartIdSeen: string | null = null;
  private lineCount = 0;

  constructor(
    private readonly bk: BlinkitPage,
    private readonly page: Page,
    private readonly closeBrowser: () => Promise<void>,
    address: VendorAddress,
  ) {
    this.address = address;
    // The cart id the vendor is working with, overheard from its own calls.
    // It is what the verdict is matched on afterwards.
    this.page.on('request', (r) => {
      const m = r.url().match(/\/v5\/carts\/(\d+)/) ?? r.url().match(/\/createOrder\/(\d+)/);
      if (m) this.cartIdSeen = m[1];
    });
  }

  async addresses(): Promise<VendorAddress[]> {
    try {
      const raw = (await this.page.evaluate(`localStorage.getItem('addressesV2')`)) as string | null;
      return readStoredAddresses(raw ?? undefined);
    } catch {
      return [];
    }
  }

  // The address is chosen when the browser is opened, because on this vendor
  // it also chooses the STORE.
  async useAddress(address: VendorAddress): Promise<boolean> {
    return String(address.id) === String(this.address?.id);
  }

  // What the vendor's own cart page says. Read, never replaced: this vendor's
  // API cart and its page cart are different things.
  async state(): Promise<CartState> {
    const read = await this.bk.readCart();
    this.lineCount = read.lines.length;
    return {
      lines: read.lines.map((l, i) => ({ sku: String(i), name: l.name, quantity: l.quantity })),
      bill: {
        itemTotal: read.itemTotal,
        toPay: read.toPay,
        delivery: read.delivery,
        surge: null,
        smallCart: null,
        other: read.other,
        freeDeliveryAbove: null,
      },
      serving: true,
      eta: read.eta,
      message: null,
      statuses: [],
    };
  }

  async set(want: CartWant): Promise<CartLineResult> {
    // Ask the store's own search before opening a single page.
    //
    // The cart WRITE is the thing this vendor hides from its checkout; its
    // reads are open, and one of them answers "do you sell this, and is it in
    // stock" in about a second. Without it a thing the store does not have
    // cost three page loads to find that out - the widening ladder, all of it
    // wasted - and the household waited through every one of them.
    //
    // This only decides whether to bother. What goes in the cart is still the
    // page's own ADD button, because that is the only cart the checkout can
    // see.
    const lookup = await this.bk.lookup(want.product || want.item, want.pack);
    if (lookup === 'not_listed' || lookup === 'out_of_stock') {
      return { item: want.item, product: want.product, pack: want.pack, wanted: want.qty, inCart: 0, state: lookup, price: null, note: null };
    }

    const got = await this.bk.addByName(want.product || want.item, want.pack, lookup?.query);
    if (!got) {
      return { item: want.item, product: want.product, pack: want.pack, wanted: want.qty, inCart: 0, state: 'not_listed', price: null, note: null };
    }
    // More than one of a thing: the vendor's own plus on the same card.
    let inCart = 1;
    for (let i = 1; i < want.qty; i++) if (await this.bk.addMore(got.name)) inCart++;
    this.lineCount += 1;
    return {
      item: want.item,
      product: got.name,
      pack: got.pack || want.pack,
      wanted: want.qty,
      inCart,
      state: 'added',
      price: got.price,
      note: inCart < want.qty ? `only ${inCart} went in` : null,
    };
  }

  // Put the cart back together in this browser.
  //
  // It cannot be carried, and that was worth proving rather than assuming,
  // because rebuilding is the slowest thing a payment does. Measured
  // 2026-09-23, on this household's own account:
  //
  //   - two browsers minutes apart reported the SAME `deviceId` and the same
  //     `gr_1_deviceId` cookie, and the second saw an empty cart. So the cart
  //     is not held against the device.
  //   - the cart the checkout shows is in the browser's own `localStorage`
  //     under `cart`. Saved from the browser that filled it and written back
  //     into a fresh one, the bytes were still there afterwards and the cart
  //     page still said "You don't have any items in your cart": the page
  //     mirrors its cart there, it does not read it from there.
  //
  // So the wanted list is added again, by clicking the vendor's own buttons,
  // exactly as the cart job added it. What makes a payment quick is each add
  // being quick - see `addBySearch` - not skipping this.
  async refill(wanted: CartWant[]): Promise<CartLineResult[]> {
    const out: CartLineResult[] = [];
    for (const want of wanted) out.push(await setWithAlternatives(this, want));
    // What went in, so the payment screen can be checked against it. Without
    // this the checkout was opened knowing nothing about the cart it was
    // about to pay for, and reported its items as null.
    this.lineCount = out.filter((l) => l.inCart > 0).length;
    return out;
  }

  async paymentOptions(): Promise<PaymentOption[]> {
    const checkout = this.checkout();
    const screen = await checkout.open().catch(() => null);
    return (screen?.cards ?? []).map((label) => ({ kind: 'card' as const, label, needsPerson: true }));
  }

  checkout(): Checkout {
    // Read now, not when this session was built: the cart id is overheard
    // from the vendor's own calls and the line count comes from reading its
    // cart page, and neither has happened yet at construction. Captured
    // early, the verdict afterwards had no cart to match on.
    this.checkoutSession ??= new BlinkitPageCheckout(
      this.bk,
      this.page,
      this.cartIdSeen,
      this.lineCount || null,
      this.address?.label ?? null,
      (path, method, body) => this.call(path, method, body),
    );
    return this.checkoutSession;
  }

  // The vendor's own endpoints, from inside its page, for the verdict. One
  // implementation, on the page that knows what this vendor requires.
  async call(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<{ status: number; body: string }> {
    return this.bk.call(path, method, body);
  }

  async close(): Promise<void> {
    await this.closeBrowser();
  }
}

export function blinkitPageAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    async open(session: CapturedSession, deliverTo: VendorAddress | string | null): Promise<CartSession> {
      if (!deliverTo || typeof deliverTo === 'string') throw new CartError('address_needed');
      const { page, blinkit, close } = await openBlinkitPage(session, deliverTo, launch);
      return new BlinkitPageSession(blinkit, page, close, deliverTo);
    },
  };
}
