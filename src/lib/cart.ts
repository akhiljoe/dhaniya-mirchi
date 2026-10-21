// Add to cart in the browser (design §19 Ordering, stage 1). The page asks
// and follows; the worker fills the household's real cart in the app, and the
// household pays there. Nothing here touches payment.
import { api } from './api';
import { CART_SECONDS_PER_ITEM, CART_START_SECONDS } from './constants';

export interface CartWant {
  item: string; // canonical item ("milk")
  product: string; // the app's own product name, or what to search for
  pack: string;
  qty: number;
  match?: 'exact' | 'search';
  // The rest of the household's ranking for this item, for when the store
  // has not got the first: products they have bought before, best first,
  // each with its pack. The worker takes the first the store has and says
  // which it took (adapters/alternatives.ts).
  alternatives?: { product: string; pack: string }[];
}

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

export interface CartBill {
  itemTotal: number | null;
  toPay: number | null;
  delivery: number | null;
  surge: number | null;
  smallCart: number | null;
  // Fees the store sums rather than itemises (Blinkit's handling, late-night
  // and small-cart charges arrive as one number). Absent on older carts.
  other?: number | null;
  // What the store says delivery is free above, in its own words. Null on
  // carts filled before we started reading it, and on any store that does
  // not say - the pages then say nothing rather than guess a figure.
  freeDeliveryAbove?: number | null;
}

export interface CartJob {
  status: 'requested' | 'running' | 'done' | 'failed';
  vendor: string;
  errorCode: string | null;
  result: {
    lines?: CartLineResult[];
    bill?: CartBill;
    eta?: string | null;
    message?: string | null;
    address?: string | null;
    // How much the household already had in the cart when we started. The
    // app keeps its own copy and pushes it up: with anything of theirs in
    // there, opening it replaces the cart and ours goes (design §19 stage 1).
    theirsBefore?: number;
    // The store's whole cart by name, ours and theirs, so the page can set
    // apart what was already there. Absent on carts filled before this.
    cart?: { name: string; quantity: number }[];
    // Stopped part way on the household's own say-so. What went in is in the
    // cart, which is why this is not a failure.
    stopped?: boolean;
  } | null;
}

export function addToCart(vendor: string, items: CartWant[]): Promise<{ id: string }> {
  return api('POST', '/api/cart/add', { vendor, items });
}

// One cart in the list: enough to show what is happening without the detail.
export interface CartJobSummary {
  id: string;
  status: CartJob['status'];
  vendor: string;
  items: number;
  result: CartJob['result'];
  errorCode: string | null;
  at: string;
  // An order exists at the store for this cart: Pay was pressed on it. Such a
  // cart is over as far as the line is concerned - it is never offered again.
  ordered?: boolean;
  // Set by the page, never the api: earlier sends to the same app folded
  // into this one for showing (lib/dock.ts). Dismissing it dismisses all.
  mergedIds?: string[];
}

export function listCartJobs(): Promise<{ jobs: CartJobSummary[] }> {
  return api('GET', '/api/cart/jobs');
}

// Stop one that is filling. `stopped` false means it was already running and
// will stop after the item it is on - what is in the cart stays.
export function cancelCart(id: string): Promise<{ stopped: boolean }> {
  return api('POST', `/api/cart/jobs/${encodeURIComponent(id)}/cancel`, {});
}

export function getCartJob(id: string): Promise<CartJob> {
  return api('GET', `/api/cart/jobs/${encodeURIComponent(id)}`);
}

export const CART_ERROR_TEXT: Record<string, string> = {
  cancelled: 'Stopped. Nothing was added to the cart.',
  not_serving: "The app isn't delivering to you right now. Try again in a while.",
  unauthorized: 'That app needs connecting again. Open the Grocery apps page.',
  address_needed: "We couldn't tell which address to use. Place one order in the app first.",
  unreachable: "The app didn't answer just now. Please try again.",
  interrupted: 'That stopped halfway. Check your cart in the app before trying again.',
  unsupported_vendor: "We can't fill a cart on that app yet.",
  internal: 'Something went wrong. Check your cart in the app.',
};
export const CART_ERROR_FALLBACK = 'Something went wrong. Check your cart in the app.';

// How long a cart of this many items should take, and what is left of it.
export function cartSecondsLeft(items: number, startedAt: string, now: Date): number {
  const total = CART_START_SECONDS + CART_SECONDS_PER_ITEM * items;
  return Math.max(0, Math.round(total - (now.getTime() - Date.parse(startedAt)) / 1000));
}

// "about 20 seconds left", "any moment now"
export function timeLeftText(seconds: number): string {
  if (seconds <= 0) return 'any moment now';
  if (seconds < 10) return 'a few seconds left';
  return `about ${Math.round(seconds / 5) * 5} seconds left`;
}

// What did not make it into the cart. A fill can finish perfectly well with
// something missing - the store does not stock that pack today, or it is out
// - and the household only found out by opening the sheet and reading every
// line. Six of seven went in and nothing said so.
export function missedFromCart(job: Pick<CartJob, 'result'> | null): { count: number; names: string[] } {
  const missed = (job?.result?.lines ?? []).filter((l) => l.state === 'out_of_stock' || l.state === 'not_listed' || l.state === 'failed');
  return { count: missed.length, names: missed.map((l) => l.item) };
}

// What is in the cart, counted. A number - "6 items" - does not answer the
// question the household actually has, which is whether the three milks they
// asked for are the three that went in. The names and their counts do, and
// they say it without anyone opening the sheet and reading every line.
export function inCartFromCart(job: Pick<CartJob, 'result'> | null): { count: number; names: string[] } {
  const went = (job?.result?.lines ?? []).filter((l) => (l.state === 'added' || l.state === 'already_there') && l.inCart > 0);
  return { count: went.length, names: went.map((l) => (l.inCart > 1 ? `${l.item} ×${l.inCart}` : l.item)) };
}

// Said after a fill that landed in a cart the household had already put
// things in: the app will overwrite ours the moment it is opened, and the
// household should hear that from us rather than from an empty basket at
// checkout. Null when the cart was ours alone, which is the ordinary case.
export function cartRaceWarning(job: Pick<CartJob, 'result'> | null): string | null {
  const theirs = job?.result?.theirsBefore ?? 0;
  if (theirs <= 0) return null;
  return `The app already had ${theirs} ${theirs === 1 ? 'item' : 'items'} in its cart. Opening it can replace what we added - empty the cart there, then send again.`;
}

// What the last filled cart was charged for delivery, and what the store said
// it would be free above. Read from the most recent cart that knows each,
// because a basket being built has no cart yet and the terms do not change
// between one shop and the next. Null before the household's first cart:
// nothing is said rather than a figure guessed (design §9.3).
export function deliveryTerms(
  jobs: Pick<CartJobSummary, 'result'>[],
  saved?: { fee: number | null; freeAbove: number | null } | null,
): { fee: number | null; freeAbove: number | null } {
  const bills = jobs.map((j) => j.result?.bill).filter((b): b is CartBill => !!b);
  // This session's carts first, then what the connection remembers from
  // earlier ones. The saved pair is what lets the app say anything about
  // delivery BEFORE a cart exists, which is when it is worth saying.
  return {
    fee: bills.find((b) => typeof b.delivery === 'number')?.delivery ?? saved?.fee ?? null,
    freeAbove: bills.find((b) => typeof b.freeDeliveryAbove === 'number')?.freeDeliveryAbove ?? saved?.freeAbove ?? null,
  };
}
