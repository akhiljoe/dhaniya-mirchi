// The household the pages show, built from real orders (design §9, §12).
//
//   orders ──catalog──▶ items ──engine──▶ predictions ──here──▶ words
//
// The catalog decides which item a line is; the engine does every quantity,
// rate, date and status; this file only words the results. Nothing here
// invents a number: no rate → "not enough history yet", no pack → "pack size
// not known yet".
import { categoryLabel, classifyLine, displayName, isStock, type Category } from '@/catalog/classify';
import {
  analyze,
  categoryDefaults,
  coverageGaps,
  due,
  formatQty,
  stockCoversToday,
  lineQty,
  type AwayPeriod,
  type DueStatus,
  type HouseholdSize,
  type Purchase,
  type Unit,
} from '@/engine';

import { api } from './api';
import { compareLikely } from './list';
import { ProductTally } from './products';
import { promptedPurchases, type PromptedAdd } from './prompted';
import { memberName } from './members';
import {
  HISTORY_SPEND_DAYS,
  INSIGHT_DAY_SHARE,
  INSIGHT_MIN_ORDERS,
  INSIGHT_TOP_ITEMS,
  INSIGHT_WEEKS,
  INVENTORY_MIN_PURCHASES,
  INVENTORY_RECENT_DAYS,
} from './constants';
import type { InventoryItem, PurchaseHistoryEntry, PurchaseRecord, ShoppingListItem, SourceId } from '../types';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface ApiOrder {
  vendor: string;
  orderId: string;
  placedAt: string;
  total: number | null;
  addressLabel: string | null;
  // The email of the member whose account placed it (design §19), and what
  // the pages call them.
  by?: string | null;
  byName?: string | null;
  // DELIVERED, or still on its way (e.g. ACTIVE). Absent = delivered.
  status?: string;
  // `prepared`: the vendor marks the line as food made to eat now (Zepto Cafe).
  items: { name: string; count: number; pricePaid: number | null; packLabel: string | null; prepared?: boolean | null }[];
}

export interface ApiCoverage {
  vendor: string;
  coverageStart: string | null;
}

export function fetchOrders(): Promise<{ orders: ApiOrder[]; coverage: ApiCoverage[] }> {
  return api('GET', '/api/orders');
}

export interface Insight {
  title: string;
  detail: string;
}

export interface Household {
  inventory: InventoryItem[];
  shopping: ShoppingListItem[];
  history: PurchaseHistoryEntry[];
  summary: { orders: number; items: number; spend30d: number };
  insight: Insight | null;
}

// ---- Dates, in the household's timezone --------------------------------------

// Building an Intl formatter is slow and these run thousands of times (the
// backtest replays every day), so each is made once per timezone.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: 'day' | 'label' | 'weekday', tz: string): Intl.DateTimeFormat {
  const key = `${kind}:${tz}`;
  let f = formatters.get(key);
  if (!f) {
    f =
      kind === 'day' ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      : kind === 'label' ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' })
      : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
    formatters.set(key, f);
  }
  return f;
}

function dayNumber(d: Date, tz: string): number {
  const [y, m, day] = formatter('day', tz)
    .format(d)
    .split('-')
    .map(Number);
  return Date.UTC(y, m - 1, day) / MS_PER_DAY;
}
const daysBetween = (a: Date, b: Date, tz: string) => dayNumber(b, tz) - dayNumber(a, tz);

// "today", "yesterday", "5 days ago", "3 weeks ago", "2 months ago".
export function relativeDay(at: Date, now: Date, tz: string): string {
  const n = daysBetween(at, now, tz);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}

// For things that happen by the hour ("Last synced 2 hours ago"); past a day,
// the same words as relativeDay.
export function timeAgo(at: Date, now: Date, tz: string): string {
  const ms = now.getTime() - at.getTime();
  if (ms < MS_PER_MINUTE) return 'just now';
  if (ms < MS_PER_HOUR) return `${Math.floor(ms / MS_PER_MINUTE)} min ago`;
  if (ms < MS_PER_DAY) {
    const h = Math.floor(ms / MS_PER_HOUR);
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  return relativeDay(at, now, tz);
}

function dateLabel(at: Date, now: Date, tz: string): string {
  const n = daysBetween(at, now, tz);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  return formatter('label', tz).format(at);
}

// ---- Words for the engine's numbers --------------------------------------------

export function runsOutText(daysUntilLow: number | null): string {
  if (daysUntilLow === null) return 'not enough history yet';
  if (daysUntilLow <= 0) return 'any day now';
  // A day away is a day the household can name. "~1 day" reads like a
  // measurement; "tomorrow" reads like an answer.
  if (daysUntilLow === 1) return 'tomorrow';
  return `~${daysUntilLow} days`;
}

// Finishes "likely to run out …"; null when there's no estimate to give.
export function runsOutIn(daysUntilLow: number | null): string | null {
  if (daysUntilLow === null) return null;
  if (daysUntilLow <= 1) return runsOutText(daysUntilLow); // "any day now", "tomorrow"
  return `in ${runsOutText(daysUntilLow)}`;
}

function frequencyText(avgIntervalDays: number | null): string {
  if (avgIntervalDays === null) return 'Not enough history yet';
  const d = Math.round(avgIntervalDays);
  return d <= 1 ? 'Every day' : `Every ~${d} days`;
}

function lineText(count: number, packLabel: string | null): string {
  if (!packLabel) return count === 1 ? '1 pack' : `${count} packs`;
  return count === 1 ? packLabel : `${count} × ${packLabel}`;
}

// The status comes from when the household will likely buy it next (the
// engine's due.ts, design §9.6); the amount left from the stock estimate.
const STATUS: Record<DueStatus, InventoryItem['status']> = {
  BUY_SOON: 'likely-low',
  RUNNING_LOW: 'coming-up',
  AVAILABLE: 'plenty',
  STOPPED: 'unknown',
  UNKNOWN: 'unknown',
};
const STATUS_ORDER: InventoryItem['status'][] = ['likely-low', 'coming-up', 'plenty', 'unknown'];

// ---- Building it ----------------------------------------------------------------

interface ItemAcc {
  canonical: string;
  category: Category;
  unit: Unit;
  emoji: string;
  // One purchase per order: two lines of the same item in one order are one
  // shopping trip (quantities summed; unknown if any line's is).
  byOrder: Map<string, { at: Date; vendor: string; qty: number | null; texts: string[]; price: number | null; prompted: boolean }>;
  // The products bought for it, once per order (design §19 "which product").
  products: ProductTally;
  productOrders: Set<string>; // `${orderId}|${product}` already counted
}

// What the household told us about itself (design §9.12): who lived here
// when, and items used every day. Items are canonical names; perDay in the
// item's canonical unit (null = every day, amount not given).
export interface HouseholdProfile {
  sizes: HouseholdSize[];
  regular: { item: string; from: Date; to: Date | null; perDay: number | null }[];
  away: AwayPeriod[];
}
export const NO_PROFILE: HouseholdProfile = { sizes: [], regular: [], away: [] };

// Only delivered orders are purchases; one still on its way shows in the
// history, and counts once it arrives.
export const isDelivered = (o: ApiOrder) => !o.status || o.status === 'DELIVERED';

export function buildHousehold(
  allOrders: ApiOrder[],
  coverage: ApiCoverage[],
  now: Date,
  tz: string,
  profile: HouseholdProfile = NO_PROFILE,
  // What the app itself put in a cart: those purchases are evidence we made,
  // so they never feed the rate (design §9.2).
  promptedAdds: PromptedAdd[] = [],
): Household {
  const orders = allOrders.filter(isDelivered);
  const prompted = promptedPurchases(orders, promptedAdds);
  const items = new Map<string, ItemAcc>();
  for (const o of orders) {
    const at = new Date(o.placedAt);
    for (const l of o.items) {
      const c = classifyLine(l);
      if (!isStock(c)) continue;
      const acc = items.get(c.canonical) ?? {
        canonical: c.canonical,
        category: c.category,
        unit: c.unit,
        emoji: c.emoji,
        byOrder: new Map(),
        products: new ProductTally(now),
        productOrders: new Set<string>(),
      };
      const once = `${o.orderId}|${l.name.toLowerCase()}`;
      if (!acc.productOrders.has(once)) {
        acc.productOrders.add(once);
        acc.products.add(l.name, l.packLabel, o.vendor, at, l.count);
      }
      items.set(c.canonical, acc);
      const qty = lineQty(l.count, l.packLabel, acc.unit);
      const wasPrompted = prompted.has(`${o.orderId}|${c.canonical}`);
      const p = acc.byOrder.get(o.orderId);
      if (p) {
        p.qty = p.qty === null || qty === null ? null : p.qty + qty;
        p.texts.push(lineText(l.count, l.packLabel));
        p.price = p.price === null || l.pricePaid === null ? null : p.price + l.pricePaid;
      } else {
        acc.byOrder.set(o.orderId, { at, vendor: o.vendor, qty, texts: [lineText(l.count, l.packLabel)], price: l.pricePaid, prompted: wasPrompted });
      }
    }
  }

  const gaps = coverageGaps(coverage.map((c) => ({ source: c.vendor, coverageStart: c.coverageStart ? new Date(c.coverageStart) : null })));

  const inventory: InventoryItem[] = [];
  for (const acc of items.values()) {
    const bought = [...acc.byOrder.entries()].sort((a, b) => b[1].at.getTime() - a[1].at.getTime());
    const purchases: Purchase[] = bought.map(([, p]) => ({ at: p.at, qty: p.qty, prompted: p.prompted }));
    const last = bought[0][1].at;
    if (bought.length < INVENTORY_MIN_PURCHASES && daysBetween(last, now, tz) > INVENTORY_RECENT_DAYS) continue;

    // Household facts (design §9.12): pet food scales with the pets,
    // everything else with the people; the item's own regular use.
    const facts = {
      scalesWith: acc.category === 'pet' ? ('pets' as const) : ('people' as const),
      regular: profile.regular.filter((r) => r.item === acc.canonical),
    };
    const pred = analyze({ itemId: acc.canonical, unit: acc.unit, purchases, ...categoryDefaults(acc.category), ...facts }, now, { gaps, sizes: profile.sizes, away: profile.away });
    const next = due(purchases, now, { gaps, sizes: profile.sizes, away: profile.away }, undefined, facts);
    const known = purchases.map((p) => p.qty).filter((q): q is number => q !== null);
    // Longer than every gap it has had: stopped, or bought elsewhere. Shown
    // as "not bought in a while", never nagged about.
    const dormant = next.status === 'STOPPED';

    const status = STATUS[next.status];
    // Flagged, but there is still some in the house: say so, rather than let
    // the card read "buy milk" beside "About 972 ml left" (engine
    // holdback.ts). The flag itself is unchanged - suppressing it was
    // measured and lost a fifth of the recall.
    const enoughForToday = next.status === 'BUY_SOON' && stockCoversToday(pred);
    const daysUntilLow = status === 'unknown' || next.daysToNext === null ? null : Math.max(0, Math.floor(next.daysToNext));
    let estimatedAmount: string;
    if (enoughForToday) estimatedAmount = 'Low by tomorrow';
    else if (dormant) estimatedAmount = 'Not bought in a while';
    else if (bought.length === 1) estimatedAmount = 'Bought once';
    // No pack size on any buy. If the rhythm still says it is due, say THAT:
    // "pack size not known" beside "running low" read as a contradiction,
    // when what the app knows is when they buy it, not how much is left.
    else if (known.length === 0) estimatedAmount = status === 'likely-low' ? 'Usually bought by now' : 'Pack size unknown';
    else if (pred.dailyRate === null) estimatedAmount = 'Not enough history';
    // Packs are known for some buys, so it is the amount LEFT that is not -
    // the latest buy's size is missing, or the intervals could not be used.
    // It used to say the pack was unknown here, beside a sentence naming it.
    else if (pred.qtyRemaining === null) estimatedAmount = status === 'likely-low' ? 'Usually bought by now' : 'Amount left unknown';
    else {
      // An estimate that rounds to nothing is not a measurement. "About 0 g
      // left" reads as a fact, and sat on the same card as "Plenty" - which
      // is the rhythm saying they are not due to buy it yet. Both are true;
      // the number was the only thing pretending to be precise.
      const left = formatQty(pred.qtyRemaining, acc.unit);
      // Pieces have no unit after the number ("0", not "0 g"), so the zero
      // test cannot insist on a space: "About 0 left" got through for pads.
      estimatedAmount = /^0(\.0+)?(\s|$)/.test(left) ? 'Probably used up' : `About ${left} left`;
    }

    const sortedKnown = [...known].sort((a, b) => a - b);
    const mid = Math.floor(sortedKnown.length / 2);
    const typical = sortedKnown.length === 0 ? null : sortedKnown.length % 2 ? sortedKnown[mid] : (sortedKnown[mid - 1] + sortedKnown[mid]) / 2;

    const history: PurchaseRecord[] = bought.map(([orderId, p]) => ({
      id: `${orderId}:${acc.canonical}`,
      date: dateLabel(p.at, now, tz),
      source: p.vendor as SourceId,
      quantity: p.texts.join(' + '),
      price: p.price ?? 0,
    }));

    inventory.push({
      id: acc.canonical,
      name: displayName(acc.canonical),
      emoji: acc.emoji,
      category: categoryLabel(acc.category),
      unit: acc.unit,
      estimatedAmount,
      daysUntilLow,
      dueRatio: next.usualGapDays && next.daysSinceLast !== null ? next.daysSinceLast / next.usualGapDays : null,
      usualGapDays: next.usualGapDays,
      likelihood: next.likelihood,
      confidence: pred.confidence === 'unknown' ? 'low' : pred.confidence,
      confidenceReason: pred.confidenceReason,
      lastPurchased: relativeDay(last, now, tz),
      lastPurchasedAt: last.toISOString(),
      purchaseFrequency: dormant ? 'Not bought recently' : frequencyText(next.usualGapDays),
      typicalQuantity: typical === null ? 'an unknown amount' : formatQty(typical, acc.unit),
      history,
      products: acc.products.products(),
      status,
    });
  }
  // Status first; within a status, the most likely first (list.ts).
  inventory.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || compareLikely(a, b) || a.name.localeCompare(b.name));

  const shopping: ShoppingListItem[] = inventory
    .filter((i) => i.status === 'likely-low' || i.status === 'coming-up')
    .map((i) => ({
      id: `shop-${i.id}`,
      name: i.name,
      emoji: i.emoji,
      reason: `${i.purchaseFrequency} · last bought ${i.lastPurchased}`,
      urgency: i.status === 'likely-low' ? 'soon' : 'coming-up',
      confidence: i.confidence,
      status: 'pending',
    }));

  const newestFirst = [...allOrders].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  // Name who placed each order only when more than one person's orders are here.
  const named = new Set(orders.map((o) => o.by ?? null)).size > 1;
  const history: PurchaseHistoryEntry[] = newestFirst.map((o) => ({
    id: o.orderId,
    date: dateLabel(new Date(o.placedAt), now, tz),
    at: o.placedAt,
    items: o.items.map((l) => {
      const c = classifyLine(l);
      return {
        item: c.canonical,
        product: l.name,
        pack: l.packLabel ?? '',
        count: Math.max(1, Math.round(l.count)),
        name: displayName(c.canonical),
        emoji: c.emoji,
        quantity: lineText(l.count, l.packLabel),
        price: l.pricePaid ?? 0,
      };
    }),
    source: o.vendor as SourceId,
    total: o.total ?? 0,
    location: o.addressLabel ?? undefined,
    by: named ? memberName(o.by ?? null, false, o.byName ?? null) : undefined,
    onTheWay: !isDelivered(o) || undefined,
  }));
  const summary = {
    orders: orders.length,
    items: orders.reduce((n, o) => n + o.items.length, 0),
    spend30d: orders
      .filter((o) => daysBetween(new Date(o.placedAt), now, tz) < HISTORY_SPEND_DAYS)
      .reduce((n, o) => n + (o.total ?? 0), 0),
  };

  return { inventory, shopping, history, summary, insight: insightOf(orders, now, tz) };
}

// "You shop for groceries about 4 times a week — usually on Saturdays. Your
// most frequent purchases are milk, bread and eggs." Counted, not guessed.
function insightOf(orders: ApiOrder[], now: Date, tz: string): Insight | null {
  const recent = orders.filter((o) => daysBetween(new Date(o.placedAt), now, tz) < INSIGHT_WEEKS * 7);
  if (recent.length < INSIGHT_MIN_ORDERS) return null;
  const tripDays = new Set(recent.map((o) => dayNumber(new Date(o.placedAt), tz)));
  const earliest = Math.min(...recent.map((o) => new Date(o.placedAt).getTime()));
  const weeks = Math.max(1, (now.getTime() - earliest) / MS_PER_DAY) / 7;
  const perWeek = tripDays.size / weeks;

  const title =
    perWeek >= 1.5
      ? `You shop for groceries about ${Math.round(perWeek)} times a week`
      : perWeek >= 0.75
        ? 'You shop for groceries about once a week'
        : `You shop for groceries about ${Math.max(1, Math.round(perWeek * 4.3))} times a month`;

  const byWeekday = new Map<string, number>();
  const fmt = formatter('weekday', tz);
  for (const o of recent) byWeekday.set(fmt.format(new Date(o.placedAt)), (byWeekday.get(fmt.format(new Date(o.placedAt))) ?? 0) + 1);
  const [topDay, topCount] = [...byWeekday.entries()].sort((a, b) => b[1] - a[1])[0];
  const dayText = topCount / recent.length >= INSIGHT_DAY_SHARE ? `Most often on ${topDay}s. ` : '';

  const counts = new Map<string, number>();
  for (const o of recent) {
    const seen = new Set<string>();
    for (const l of o.items) {
      const c = classifyLine(l);
      if (c.category === 'exclude' || seen.has(c.canonical)) continue;
      seen.add(c.canonical);
      counts.set(c.canonical, (counts.get(c.canonical) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, INSIGHT_TOP_ITEMS).map(([n]) => n);
  const itemsText =
    top.length === 0 ? ''
    : top.length === 1 ? `Your most frequent purchase is ${top[0]}.`
    : `Your most frequent purchases are ${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}.`;

  return { title, detail: `${dayText}${itemsText}`.trim() };
}
