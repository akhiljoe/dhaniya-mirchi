// What to do, from the orders (design §12.7 by another road). Insights had
// numbers: what was spent, when, on what. A number is not an insight until
// it says what to do about it, so this turns the same orders into sentences
// with a verb in them:
//
//   - which things are ahead of their usual spend this cycle (ease off, or
//     know why the forecast is high);
//   - which things keep coming as their own order on a day that already had
//     one (add them to the other order; the fee is the waste);
//   - where a bigger pack the household has already bought is cheaper per
//     litre or kilo than the one it mostly buys;
//   - which products have gone up in price lately;
//   - what was bought once, long ago, and is still being tracked.
//
// Every figure is counted from the orders; nothing here is estimated, and
// where a number would be a guess the sentence is left out (§9.3). Pure, no
// I/O, no clock of its own.
import { classifyLine, displayName, isStock } from '@/catalog/classify';
import { parsePackLabel } from '@/engine';

import {
  ADVICE_AHEAD_MIN_CYCLES,
  ADVICE_AHEAD_MIN_RATIO,
  ADVICE_AHEAD_MIN_RUPEES,
  ADVICE_AHEAD_SHOWN,
  ADVICE_ONCE_MIN_DAYS,
  ADVICE_ONCE_SHOWN,
  ADVICE_PACK_MIN_BUYS,
  ADVICE_PACK_MIN_RATIO,
  ADVICE_PACK_MIN_SAVING,
  ADVICE_PACK_SHOWN,
  ADVICE_PRICE_BEFORE_MIN,
  ADVICE_PRICE_MIN_RISE,
  ADVICE_PRICE_RECENT_DAYS,
  ADVICE_PRICE_RECENT_MIN,
  ADVICE_PRICE_SHOWN,
  ADVICE_SOLO_MAX_ITEMS,
  ADVICE_SOLO_MIN_TIMES,
  ADVICE_SOLO_SHOWN,
} from './constants';
import { isDelivered, type ApiOrder } from './household';

const MS_PER_DAY = 86_400_000;

export type AdviceKind = 'ahead' | 'separate_trips' | 'bigger_pack' | 'price_rise' | 'bought_once';

export interface Advice {
  kind: AdviceKind;
  title: string; // one line, with the verb in it
  detail: string; // the numbers behind it, one line
  // Rupees at stake where that can be counted, for ordering; null otherwise.
  amount: number | null;
  // The canonical item it is about, when it is about one.
  item: string | null;
  // For "bought once": the things, so the page can offer to stop tracking each.
  items?: { item: string; name: string }[];
}

export interface AdviceInput {
  now: Date;
  tz: string;
  // The household's spending cycle as the forecast names it; null when there
  // is no forecast yet, and then nothing is said about being ahead.
  cycle: { from: string; to: string } | null;
  // What one order's fees typically come to; null when unknown, and then the
  // separate-trip advice names the trips but not the rupees.
  feePerOrder: number | null;
}

// Day number (UTC midnights) of an instant, in the household's own day.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayNumber(at: Date, tz: string): number {
  let f = dayFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' });
    dayFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / MS_PER_DAY;
}
const dayOfIso = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rupees = (n: number) => (n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`);

interface Line {
  item: string; // canonical
  emoji: string;
  product: string;
  pack: string | null;
  count: number;
  price: number | null; // for the line, all packs together
  at: Date;
  day: number;
  orderId: string;
}

// Every delivered line, classified once.
function linesOf(orders: ApiOrder[], tz: string): Line[] {
  const out: Line[] = [];
  for (const o of orders) {
    if (!isDelivered(o)) continue;
    const at = new Date(o.placedAt);
    const day = dayNumber(at, tz);
    for (const l of o.items) {
      const c = classifyLine(l);
      if (!isStock(c)) continue;
      out.push({ item: c.canonical, emoji: c.emoji, product: l.name, pack: l.packLabel, count: Math.max(1, l.count), price: l.pricePaid, at, day, orderId: o.orderId });
    }
  }
  return out;
}

export function adviceFor(orders: ApiOrder[], input: AdviceInput): Advice[] {
  const lines = linesOf(orders, input.tz);
  const today = dayNumber(input.now, input.tz);
  // One of each kind first, then the rest. The page shows a few and hides
  // the rest behind "more", so the few must not all be one kind: three
  // "ahead of usual" lines and nothing else is a worse three than one of
  // each. Within a kind the order is the kind's own (biggest first).
  const groups = [
    aheadThisCycle(lines, today, input.cycle),
    separateTrips(lines, input.feePerOrder),
    biggerPack(lines, today),
    priceRises(lines, today),
    boughtOnce(lines, today),
  ];
  const out: Advice[] = [];
  for (let round = 0; groups.some((g) => g.length > round); round++) {
    for (const g of groups) if (g[round]) out.push(g[round]);
  }
  return out;
}

// ---- Ahead of usual this cycle ------------------------------------------------
// Per item, what this cycle has spent so far against what the same number of
// days into each earlier cycle came to. The forecast says the cycle is ₹8.9k
// ahead; this says on what.
export function aheadThisCycle(lines: Line[], today: number, cycle: { from: string; to: string } | null): Advice[] {
  if (!cycle) return [];
  const start = dayOfIso(cycle.from);
  const daysGone = today - start + 1;
  if (daysGone < 1) return [];
  // Earlier cycle starts: the same day of the month, stepping back.
  const from = new Date(`${cycle.from}T00:00:00Z`);
  const starts: number[] = [];
  for (let k = 1; k <= 24; k++) starts.push(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - k, from.getUTCDate()) / MS_PER_DAY);
  // A past cycle counts when the record reaches into its first `daysGone`
  // days at all; asking for the whole window inside the record threw away
  // the oldest cycle every time.
  const earliest = Math.min(...lines.map((l) => l.day));
  const past = starts.filter((s) => s + daysGone - 1 >= earliest);
  if (past.length < ADVICE_AHEAD_MIN_CYCLES) return [];

  const byItem = new Map<string, { emoji: string; now: number; then: number[] }>();
  for (const l of lines) {
    if (l.price === null) continue;
    const it = byItem.get(l.item) ?? { emoji: l.emoji, now: 0, then: past.map(() => 0) };
    byItem.set(l.item, it);
    if (l.day >= start && l.day <= today) it.now += l.price;
    past.forEach((s, k) => {
      if (l.day >= s && l.day < s + daysGone) it.then[k] += l.price ?? 0;
    });
  }
  return [...byItem.entries()]
    .map(([item, it]) => ({ item, emoji: it.emoji, now: it.now, typical: median(it.then) }))
    // Only things with a usual figure to be ahead OF. Olive oil, bought every
    // two months, is "₹4.8k ahead of usual" in the cycle it is bought and
    // nothing in the others: that is a bulk buy, not a trend.
    .filter((x) => x.typical > 0 && x.now - x.typical >= ADVICE_AHEAD_MIN_RUPEES && x.now >= x.typical * ADVICE_AHEAD_MIN_RATIO)
    .sort((a, b) => b.now - b.typical - (a.now - a.typical))
    .slice(0, ADVICE_AHEAD_SHOWN)
    .map((x) => ({
      kind: 'ahead' as const,
      title: `${displayName(x.item)} is ${rupees(x.now - x.typical)} ahead of usual this cycle`,
      detail: `${rupees(x.now)} so far; by day ${daysGone} it is usually about ${rupees(x.typical)}.`,
      amount: x.now - x.typical,
      item: x.item,
    }));
}

// ---- The second order of the day ------------------------------------------------
// On a day with two or more orders, the smaller ones are the extra trips.
// A thing that keeps being the whole of an extra trip could have gone in the
// first order, and the fee on the extra trip is what it cost not to.
export function separateTrips(lines: Line[], feePerOrder: number | null): Advice[] {
  const byDay = new Map<number, Map<string, Line[]>>();
  for (const l of lines) {
    const day = byDay.get(l.day) ?? new Map<string, Line[]>();
    byDay.set(l.day, day);
    const o = day.get(l.orderId) ?? [];
    o.push(l);
    day.set(l.orderId, o);
  }
  const solo = new Map<string, { emoji: string; times: number; withItems: Map<string, number> }>();
  for (const day of byDay.values()) {
    if (day.size < 2) continue;
    // The first order of the day is the shop; the later ones are the extra
    // trips. By size instead, a big evening order made the morning milk the
    // stray, which is backwards.
    const orders = [...day.values()].sort((a, b) => a[0].at.getTime() - b[0].at.getTime());
    const main = new Set(orders[0].map((l) => l.item));
    for (const extra of orders.slice(1)) {
      const items = [...new Set(extra.map((l) => l.item))];
      if (items.length > ADVICE_SOLO_MAX_ITEMS) continue;
      for (const item of items) {
        const s = solo.get(item) ?? { emoji: extra[0].emoji, times: 0, withItems: new Map<string, number>() };
        solo.set(item, s);
        s.times++;
        for (const m of main) s.withItems.set(m, (s.withItems.get(m) ?? 0) + 1);
      }
    }
  }
  return [...solo.entries()]
    .filter(([, s]) => s.times >= ADVICE_SOLO_MIN_TIMES)
    .sort((a, b) => b[1].times - a[1].times)
    .slice(0, ADVICE_SOLO_SHOWN)
    .map(([item, s]) => {
      const withItem = [...s.withItems.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const fees = feePerOrder ? s.times * feePerOrder : null;
      return {
        kind: 'separate_trips' as const,
        title: `${displayName(item)} came as its own order ${s.times} times`,
        detail:
          (withItem ? `Add it when you order ${displayName(withItem).toLowerCase()}.` : 'Add it to the order you are already placing.') +
          (fees ? ` About ${rupees(fees)} of delivery fees.` : ''),
        amount: fees,
        item,
      };
    });
}

// ---- The bigger pack -----------------------------------------------------------
// For an item bought in more than one pack size, with prices: the pack the
// household mostly buys against a bigger one it has also bought. Only packs
// in the same dimension compare (ml with l, g with kg); pieces compare with
// pieces.
type Dim = 'ml' | 'g' | 'piece';
function packInBase(pack: string | null): { qty: number; dim: Dim } | null {
  if (!pack) return null;
  const p = parsePackLabel(pack);
  if (!p) return null;
  if (p.unit === 'ml') return { qty: p.pack, dim: 'ml' };
  if (p.unit === 'l') return { qty: p.pack * 1000, dim: 'ml' };
  if (p.unit === 'g') return { qty: p.pack, dim: 'g' };
  if (p.unit === 'kg') return { qty: p.pack * 1000, dim: 'g' };
  return { qty: p.pack, dim: 'piece' };
}
const perUnit = (dim: Dim) => (dim === 'ml' ? { factor: 1000, label: 'litre' } : dim === 'g' ? { factor: 1000, label: 'kg' } : { factor: 1, label: 'piece' });

export function biggerPack(lines: Line[], today: number): Advice[] {
  const byItem = new Map<string, Map<string, { product: string; pack: string; qty: number; dim: Dim; unitPrices: number[]; bought: number }>>();
  let earliest = Infinity;
  for (const l of lines) {
    if (l.price === null || l.price <= 0) continue;
    const p = packInBase(l.pack);
    if (!p) continue;
    earliest = Math.min(earliest, l.day);
    const key = `${l.product}|${l.pack}`;
    const packs = byItem.get(l.item) ?? new Map();
    byItem.set(l.item, packs);
    const s = packs.get(key) ?? { product: l.product, pack: l.pack ?? '', qty: p.qty, dim: p.dim, unitPrices: [], bought: 0 };
    packs.set(key, s);
    s.unitPrices.push(l.price / (l.count * p.qty));
    s.bought += l.count;
  }
  const months = Math.max(1, (today - earliest) / 30);
  const out: Advice[] = [];
  for (const [item, packs] of byItem) {
    const list = [...packs.values()].filter((p) => p.unitPrices.length >= ADVICE_PACK_MIN_BUYS);
    if (list.length < 2) continue;
    const usual = list.reduce((a, b) => (b.bought > a.bought ? b : a));
    const usualUnit = median(usual.unitPrices);
    const bigger = list
      .filter((p) => p !== usual && p.dim === usual.dim && p.qty >= usual.qty * ADVICE_PACK_MIN_RATIO)
      .map((p) => ({ p, unit: median(p.unitPrices) }))
      .filter((x) => x.unit <= usualUnit * (1 - ADVICE_PACK_MIN_SAVING))
      .sort((a, b) => a.unit - b.unit)[0];
    if (!bigger) continue;
    const { factor, label } = perUnit(usual.dim);
    const perMonthQty = (usual.bought * usual.qty) / months;
    const saving = perMonthQty * (usualUnit - bigger.unit);
    out.push({
      kind: 'bigger_pack',
      title: `${displayName(item)}: the ${bigger.p.pack} pack is ${Math.round((1 - bigger.unit / usualUnit) * 100)}% cheaper per ${label}`,
      detail: `You mostly buy the ${usual.pack} at ${rupees(usualUnit * factor)} a ${label}; the ${bigger.p.pack} you have bought is ${rupees(bigger.unit * factor)}. About ${rupees(saving)} a month.`,
      amount: saving,
      item,
    });
  }
  return out.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, ADVICE_PACK_SHOWN);
}

// ---- Prices that moved --------------------------------------------------------
// Per product and pack: what a pack cost in the last weeks against what it
// cost before. Compared on the same product, so a switch of brand is never
// read as a rise.
export function priceRises(lines: Line[], today: number): Advice[] {
  const byProduct = new Map<string, { item: string; recent: number[]; before: number[] }>();
  for (const l of lines) {
    if (l.price === null || l.price <= 0) continue;
    const key = [l.product, l.pack].filter(Boolean).join(' · ');
    const s = byProduct.get(key) ?? { item: l.item, recent: [], before: [] };
    byProduct.set(key, s);
    const perPack = l.price / l.count;
    const age = today - l.day;
    if (age <= ADVICE_PRICE_RECENT_DAYS) s.recent.push(perPack);
    else if (age <= 365) s.before.push(perPack);
  }
  return [...byProduct.entries()]
    .filter(([, s]) => s.recent.length >= ADVICE_PRICE_RECENT_MIN && s.before.length >= ADVICE_PRICE_BEFORE_MIN)
    .map(([label, s]) => ({ label, item: s.item, now: median(s.recent), then: median(s.before) }))
    .filter((x) => x.then > 0 && x.now / x.then - 1 >= ADVICE_PRICE_MIN_RISE)
    .sort((a, b) => b.now / b.then - a.now / a.then)
    .slice(0, ADVICE_PRICE_SHOWN)
    .map((x) => ({
      kind: 'price_rise' as const,
      title: `${x.label} is up ${Math.round((x.now / x.then - 1) * 100)}%`,
      detail: `${rupees(x.now)} a pack lately, ${rupees(x.then)} before that.`,
      amount: null,
      item: x.item,
    }));
}

// ---- Bought once, long ago -----------------------------------------------------
// Still on the stock list, still "Unsure", and never coming back. One line,
// with a way to stop tracking each.
export function boughtOnce(lines: Line[], today: number): Advice[] {
  const byItem = new Map<string, { emoji: string; days: Set<number> }>();
  for (const l of lines) {
    const s = byItem.get(l.item) ?? { emoji: l.emoji, days: new Set<number>() };
    byItem.set(l.item, s);
    s.days.add(l.day);
  }
  const once = [...byItem.entries()]
    .filter(([, s]) => s.days.size === 1 && today - [...s.days][0] >= ADVICE_ONCE_MIN_DAYS)
    .map(([item]) => ({ item, name: displayName(item) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!once.length) return [];
  return [
    {
      kind: 'bought_once',
      title: `${once.length} ${once.length === 1 ? 'thing was' : 'things were'} bought once, months ago, and never again`,
      detail: 'They sit on the stock list as "Unsure". Stop tracking the ones that are not coming back.',
      amount: null,
      item: null,
      items: once.slice(0, ADVICE_ONCE_SHOWN),
    },
  ];
}
