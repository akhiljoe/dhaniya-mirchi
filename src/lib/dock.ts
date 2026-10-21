// The one line at the bottom of the screen about the cart, and what it says.
//
// There were two cards at the top of Supplies - "Your cart is ready" and
// "Ready to send" - plus a bar at the bottom that said the same things again
// and hid whenever the cards were in view. Three surfaces for one cart, and
// the household read them as a page that could not make up its mind
// (2026-09-23: "It should be 1 tile!").
//
// So the cart has one place, the way it does in the grocery apps themselves:
// a line above the navigation that says the amount, and a sheet behind it
// with the items. What the line says is decided here, in one function, from
// what is actually going on - so the screen can be redrawn any number of
// times without the story changing underneath it.
import type { BasketLine } from './basket';
import { CART_ERROR_FALLBACK, CART_ERROR_TEXT, type CartJobSummary, type CartLineResult } from './cart';
import { CART_VENDOR_INFO, HOME_ESTIMATE_MIN_PRICED, READY_CART_MAX_AGE_MS } from './constants';
import type { Product } from './products';
import { choiceForVendor, rankProducts, type ProductPref } from './products';

export type DockState =
  // Nothing to say: no list, nothing filling, nothing waiting to be paid.
  | { kind: 'hidden' }
  // A list is being made. It is what the household is doing right now, so
  // it wins over carts that are already ready; those stay reachable from
  // inside the sheet.
  | { kind: 'picking'; lines: BasketLine[]; vendor: string; ready: CartJobSummary[] }
  // The app is being tapped through, item by item. Live, so it wins over
  // everything.
  | { kind: 'filling'; job: CartJobSummary; items: number }
  // Filled and waiting to be paid for or looked at: one cart per app, because
  // a household with two apps can have a cart on each at once - the things
  // the first store did not have, sent on to the second.
  | { kind: 'ready'; jobs: CartJobSummary[]; failed: CartJobSummary[] }
  // The last one did not work, in the store's own words.
  | { kind: 'failed'; job: CartJobSummary; text: string };

// The most recent finished cart on each app, newest first, leaving out the
// ones the household has pushed away and the ones too old to still be a
// cart. A Instamart cart from yesterday was offered as "ready · ₹705" beside
// this morning's Blinkit one (2026-09-23); the store had long since moved on.
export function latestPerVendor(jobs: CartJobSummary[], dismissed: string | null, now: Date, maxAgeMs = READY_CART_MAX_AGE_MS): CartJobSummary[] {
  // Ordered is over: the store has the order, whether or not the money was
  // read back, and the one thing not to offer is Pay. And on an app whose
  // cart is one cart at the store, an order takes every earlier send to that
  // app with it - the order was tied to the latest send, but paid for the
  // whole cart, and the sends before it would otherwise come back as a
  // "ready" cart of their own.
  const orderedAt = new Map<string, string>();
  for (const j of jobs) if (j.ordered && (orderedAt.get(j.vendor) ?? '') < j.at) orderedAt.set(j.vendor, j.at);
  const over = (j: CartJobSummary) => !!j.ordered || j.at <= (orderedAt.get(j.vendor) ?? '');

  const recent = [...jobs]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter(
      (j) =>
        (j.status === 'done' || j.status === 'failed') &&
        now.getTime() - new Date(j.at).getTime() <= maxAgeMs &&
        !isDismissed(dismissed, j.id) &&
        !over(j),
    );
  const out: CartJobSummary[] = [];
  for (const vendor of [...new Set(recent.map((j) => j.vendor))]) {
    const mine = recent.filter((j) => j.vendor === vendor);
    const latest = mine[0];
    if (latest.status !== 'done') {
      out.push(latest);
      continue;
    }
    // Several sends to one app in the window are one cart at the store, so
    // they are one cart here: three things sent, then chicken sent after,
    // showed only the chicken. The lines are the union, newest first for a
    // thing sent twice; the bill and the rest are the latest send's, because
    // the store's cart total already covers everything in it. Every folded
    // send is remembered by id, so letting the cart go lets all of them go.
    const folded = mine.filter((j) => j.status === 'done');
    const lines = folded.flatMap((j) => j.result?.lines ?? []).filter((l, i, all) => all.findIndex((m) => m.item === l.item) === i);
    // What was in the store's cart before US is what the EARLIEST send found
    // there: a later send finds the earlier sends' things and would count
    // them as the household's own ("8 things you added in the app" for 3
    // of ours and 5 of theirs).
    const earliest = folded[folded.length - 1];
    const theirsBefore = earliest.result?.theirsBefore;
    out.push({
      ...latest,
      result: latest.result ? { ...latest.result, lines, ...(theirsBefore !== undefined ? { theirsBefore } : {}) } : latest.result,
      mergedIds: folded.map((j) => j.id),
    });
  }
  return out;
}

// The ids a shown cart stands for: itself, and any earlier sends folded into it.
export function idsOf(job: CartJobSummary): string[] {
  return job.mergedIds?.length ? job.mergedIds : [job.id];
}

// Which carts have been pushed away: several ids in one remembered string,
// because there can be a cart on each app (lib/seen.ts holds one string).
export function isDismissed(dismissed: string | null, id: string): boolean {
  return !!dismissed && dismissed.split(',').includes(id);
}
export function dismissWith(dismissed: string | null, id: string): string {
  const ids = (dismissed ? dismissed.split(',') : []).filter(Boolean);
  if (!ids.includes(id)) ids.push(id);
  // The last few are plenty: a cart older than that is not on any line.
  return ids.slice(-DISMISSED_KEPT).join(',');
}
const DISMISSED_KEPT = 8;

export function dockState(input: {
  basket: BasketLine[];
  active: CartJobSummary[];
  jobs: CartJobSummary[];
  // The finished carts the household has already pushed away, by id: those
  // are over, and tomorrow's cart is a new notice (lib/seen.ts).
  dismissed: string | null;
  vendor: string;
  // Passed in, never read here: what counts as "still a cart" depends on it.
  now: Date;
}): DockState {
  const { basket, active, jobs, dismissed, vendor, now } = input;
  const items = active.reduce((n, j) => n + j.items, 0);
  if (items > 0) return { kind: 'filling', job: active[active.length - 1], items };

  const finished = latestPerVendor(jobs, dismissed, now);
  const ready = finished.filter((j) => j.status === 'done');
  if (basket.length) return { kind: 'picking', lines: basket, vendor, ready };
  // A failure on the other app rides along, so it is not swallowed by the
  // cart that worked: it gets its own tab, in the store's own words.
  if (ready.length) return { kind: 'ready', jobs: ready, failed: finished.filter((j) => j.status === 'failed') };

  const failed = finished[0];
  if (!failed) return { kind: 'hidden' };
  return { kind: 'failed', job: failed, text: CART_ERROR_TEXT[failed.errorCode ?? ''] ?? CART_ERROR_FALLBACK };
}

// Whether this cart can be paid for from here, and for how much.
export function payable(job: CartJobSummary, payEnabled: boolean): { toPay: number | null; canPay: boolean } {
  const toPay = job.status === 'done' ? (job.result?.bill?.toPay ?? null) : null;
  return { toPay, canPay: payEnabled && !!CART_VENDOR_INFO[job.vendor]?.canPay && toPay !== null && toPay > 0 };
}

// What this item last cost. The most recent purchase of it, whatever that
// came to. Null when nothing priced is known, and a null is never a zero.
export function lastPrice(item: { history: { price?: number | null }[] }): number | null {
  const priced = item.history.find((h) => typeof h.price === 'number' && h.price > 0);
  return priced ? priced.price! : null;
}

// Roughly what the list comes to, from what each thing last cost. Only worth
// showing when most of the list has a price behind it; otherwise it reads as
// a total and is short (design §9.3).
export function estimateFor(
  lines: BasketLine[],
  items: { id: string; history: { price?: number | null }[] }[],
): { total: number; trustworthy: boolean } {
  let total = 0;
  let priced = 0;
  for (const l of lines) {
    const item = items.find((i) => i.id === l.item);
    const p = item ? lastPrice(item) : null;
    if (p === null) continue;
    priced += 1;
    total += p * (l.qty || 1);
  }
  return { total, trustworthy: lines.length > 0 && priced >= lines.length * HOME_ESTIMATE_MIN_PRICED };
}

// What the store would not sell, and where else the household buys it.
//
// The answer to the question that follows "4 not available": can I get them
// somewhere? Their own orders say - every product carries the apps it was
// bought on - so this groups the misses by the other app that has sold them
// that thing, ready to be sent there in one tap. Only apps a cart can go to
// count; a thing bought nowhere else is named as such rather than left off.
export interface Elsewhere {
  vendor: string;
  lines: BasketLine[];
}

export function elsewhereFor(
  missed: CartLineResult[],
  items: { id: string; name: string; emoji: string; products?: Product[] }[],
  prefs: ProductPref[],
  vendors: string[],
  jobVendor: string,
): { elsewhere: Elsewhere[]; nowhere: string[] } {
  const byVendor = new Map<string, BasketLine[]>();
  const nowhere: string[] = [];
  for (const line of missed) {
    const item = items.find((i) => i.id === line.item);
    if (!item) {
      nowhere.push(line.item);
      continue;
    }
    const ranked = rankProducts(item.products ?? [], prefs.find((p) => p.item === item.id) ?? null).ranked;
    // Another app a cart can go to, on which they have bought this thing.
    const other = vendors.find((v) => v !== jobVendor && ranked.some((p) => p.vendors.includes(v)));
    const product = other ? choiceForVendor(ranked, other) : null;
    if (!other || !product) {
      nowhere.push(item.name);
      continue;
    }
    byVendor.set(other, [
      ...(byVendor.get(other) ?? []),
      { item: item.id, name: item.name, emoji: item.emoji, product: product.name, pack: product.pack ?? '', qty: line.wanted || 1 },
    ]);
  }
  return {
    elsewhere: [...byVendor.entries()].map(([vendor, lines]) => ({ vendor, lines })).sort((a, b) => b.lines.length - a.lines.length),
    nowhere,
  };
}
