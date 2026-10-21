// The Insights page (design §12.7): what the household's own orders say about
// how it shops. Pure: counted and computed from the orders, the catalog and
// the engine, never guessed. Each finding carries the numbers behind it.
import { categoryLabel, classifyLine, displayName } from '@/catalog/classify';
import { coverageGaps, due, type Purchase } from '@/engine';

import { adviceFor, type Advice } from './advice';
import { api } from './api';
import { isDelivered, type ApiCoverage, type ApiOrder } from './household';
import { memberName } from './members';
import {
  INSIGHTS_CATEGORIES_SHOWN,
  INSIGHTS_DAYPARTS,
  INSIGHTS_MONTHS,
  INSIGHTS_NEW_HABIT_DAYS,
  INSIGHTS_NEW_HABIT_MIN_TRIPS,
  INSIGHTS_RHYTHM_SHOWN,
  INSIGHTS_STOPPED_MIN_TRIPS,
  INSIGHTS_STOPPED_SHOWN,
  INSIGHTS_TOGETHER_MIN_LIFT,
  INSIGHTS_TOGETHER_MIN_TIMES,
  INSIGHTS_TOGETHER_SHOWN,
  INSIGHTS_TREND_DAYS,
  INSIGHTS_DEFAULT_RANGE_DAYS,
  INSIGHTS_FEES_MIN_ORDERS,
  BILLING_DAY_DEFAULT,
  FORECAST_HALF_LIFE_DAYS,
  FORECAST_HIGH_QUANTILE,
  FORECAST_LOW_QUANTILE,
  FORECAST_MID_QUANTILE,
  FORECAST_MIN_HISTORY_DAYS,
  FORECAST_MIN_WINDOWS,
  INSIGHTS_COMPARE_MIN_BUYS,
  INSIGHTS_COMPARE_MIN_GAP,
  INSIGHTS_COMPARE_SHOWN,
  INSIGHTS_ITEMS_SHOWN,
  INSIGHTS_PRODUCTS_PER_ITEM,
} from './constants';

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface Insights {
  orders: number;
  // The window every number on the page was counted over (null = all time),
  // so the page can say which, and the spend trend's own window, which stays
  // at INSIGHTS_TREND_DAYS when the range is all time (there is no "before
  // all time" to compare against).
  rangeDays: number | null;
  trendDays: number;
  // Where each app's history begins, counted from every order the household
  // has, not from the filtered window. Instamart serves a rolling 12 months
  // and Blinkit keeps years, so a window wider than the shortest history
  // compares uneven records and the page says so.
  history: { vendor: string; since: string; sinceAt: string }[];
  months: { key: string; label: string; spend: number; orders: number; partial: boolean }[]; // oldest first
  // Where this month is heading, and how sure that is. Null until there is
  // enough of a record to read a rhythm from.
  forecast: MonthForecast | null;
  trend: { recent: number; before: number; changePct: number | null }; // spend, last N days vs the N before
  weekdays: { label: string; orders: number }[]; // Mon..Sun
  dayparts: { label: string; hours: string; orders: number }[];
  categories: { label: string; spend: number; share: number }[]; // biggest first, the rest as "Everything else"
  // The items the money actually went on, biggest first, and what the rest of
  // them came to together.
  // Biggest first, each with the products the money inside it went on.
  topSpend: { name: string; emoji: string; spend: number; share: number; products: { label: string; spend: number; buys: number }[] }[];
  topSpendRest: { kinds: number; spend: number; share: number };
  rhythm: { name: string; emoji: string; everyDays: number; trips: number }[]; // most bought first
  together: { a: string; b: string; times: number; lift: number }[];
  // The same product, in the same pack, on both apps. The one comparison
  // nobody else can make for this household, because only it has both
  // histories.
  compare: PriceCompare[];
  newHabits: { name: string; emoji: string; trips: number; since: string }[];
  stopped: { name: string; emoji: string; everyDays: number; lastBought: string }[];
  members: { name: string; orders: number; spend: number; share: number }[]; // empty for a household of one
  // What the apps charged on top of the goods, and what a second trip on the
  // same day cost. Null when too few orders carry prices to say anything.
  fees: Fees | null;
  // What to do about it (lib/advice.ts): sentences with a verb, counted from
  // every delivered order the household has, not the window - advice is
  // about now.
  advice: Advice[];
}

// Delivery, handling and the rest: the order total less what the items cost.
// Only orders whose lines carry prices can say anything, so the rest are left
// out and `covered` reports how many were counted - a number that quietly
// covered a third of the orders would be a guess wearing a rupee sign.
//
// The part worth acting on is the second trip: the household orders several
// times on the same day (milk on its own, then dinner two hours later), and
// each trip pays its own fee. Those are counted separately, at the day's
// average fee, so "what a second trip costs" is measured rather than assumed.
export interface Fees {
  total: number; // in the window
  orders: number; // orders counted
  covered: number; // 0..1, share of orders whose items carried prices
  perOrder: number; // median
  daysWithExtraTrips: number;
  extraTrips: number;
  onExtraTrips: number; // the fees those extra trips carried
}

export function feesFrom(orders: ApiOrder[], tz: string): Fees | null {
  const counted: { day: string; fee: number }[] = [];
  for (const o of orders) {
    if (o.total === null || o.total <= 0) continue;
    const items = o.items.reduce((n, l) => n + (l.pricePaid ?? 0), 0);
    if (items <= 0) continue; // nothing to subtract from: says nothing
    const p = parts(new Date(o.placedAt), tz);
    counted.push({ day: `${p.y}-${p.m}-${p.d}`, fee: Math.max(0, o.total - items) });
  }
  const priced = orders.filter((o) => o.total !== null && o.total > 0);
  if (!priced.length || counted.length < INSIGHTS_FEES_MIN_ORDERS) return null;

  const byDay = new Map<string, number[]>();
  for (const c of counted) byDay.set(c.day, [...(byDay.get(c.day) ?? []), c.fee]);
  let daysWithExtraTrips = 0;
  let extraTrips = 0;
  let onExtraTrips = 0;
  for (const fees of byDay.values()) {
    if (fees.length < 2) continue;
    daysWithExtraTrips++;
    extraTrips += fees.length - 1;
    const average = fees.reduce((a, b) => a + b, 0) / fees.length;
    onExtraTrips += average * (fees.length - 1);
  }
  const sorted = counted.map((c) => c.fee).sort((a, b) => a - b);
  return {
    total: counted.reduce((n, c) => n + c.fee, 0),
    orders: counted.length,
    covered: counted.length / priced.length,
    perOrder: sorted[Math.floor(sorted.length / 2)] ?? 0,
    daysWithExtraTrips,
    extraTrips,
    onExtraTrips,
  };
}

// Calendar parts of an instant in the household's timezone.
const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function parts(d: Date, tz: string): { y: number; m: number; d: number; wd: number; h: number } {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    partsFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd: WEEKDAYS.indexOf(p.weekday), h: Number(p.hour) };
}

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const monthLabel = (key: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${key}-15T00:00:00Z`));
const shortDate = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(d);

// What this month is likely to come to (design §10.5). It behaves the way a
// maps app's arrival time does: the part already travelled is known exactly,
// the part left is estimated, and the estimate tightens by itself as there is
// less of it left to be wrong about. On the last day of the month the range
// collapses onto what was actually spent.
export interface MonthForecast {
  spent: number; // this cycle so far, which is not an estimate
  daysGone: number;
  daysLeft: number;
  // What the cycle being forecast actually is, so the page can name it: the
  // calendar month when the household bills on the 1st, and "16 Sep to 15
  // Oct" when it bills on the 16th.
  from: string; // ISO date, the household's timezone
  to: string;
  billingDay: number;
  // What the month is likely to end at. `mid` is the figure to show; the
  // other two are how wrong it could reasonably be.
  low: number;
  mid: number;
  high: number;
  // What the household had usually spent this far into a cycle. Null when
  // there are not enough past cycles to say.
  typicalByNow: number | null;
}

const daysInMonthOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNumberOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / MS_PER_DAY;
const monthBefore = (y: number, m: number) => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });
const monthAfter = (y: number, m: number) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });

// The day a cycle beginning on `billingDay` starts in a given month. A cycle
// that starts on the 31st starts on the last day of any month too short for
// it, which is what a card does too.
const startInMonth = (y: number, m: number, billingDay: number) => dayNumberOf(y, m, Math.min(billingDay, daysInMonthOf(y, m)));

// The cycle that `today` falls in: the day it started, and the day after it
// ends. With billingDay 1 this is exactly the calendar month.
export function cycleAround(today: { y: number; m: number; d: number }, billingDay: number): { start: number; nextStart: number } {
  const thisMonth = startInMonth(today.y, today.m, billingDay);
  const todayDay = dayNumberOf(today.y, today.m, today.d);
  if (todayDay >= thisMonth) {
    const next = monthAfter(today.y, today.m);
    return { start: thisMonth, nextStart: startInMonth(next.y, next.m, billingDay) };
  }
  const prev = monthBefore(today.y, today.m);
  return { start: startInMonth(prev.y, prev.m, billingDay), nextStart: thisMonth };
}

const isoOf = (dayNumber: number) => new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);

// The value at a quantile of a weighted set, with the weights as they are:
// recent windows count for more, because a household's spending drifts.
function weightedQuantile(xs: { v: number; w: number }[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a.v - b.v);
  const total = s.reduce((n, x) => n + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total * q) return x.v;
  }
  return s[s.length - 1].v;
}

export function forecastMonth(orders: ApiOrder[], now: Date, tz: string, billingDay: number = BILLING_DAY_DEFAULT): MonthForecast | null {
  // Only what has already happened. An order placed later in the month is not
  // evidence available today, and counting it would make every replay of this
  // look clairvoyant.
  const delivered = orders.filter(isDelivered).filter((o) => o.total !== null && new Date(o.placedAt).getTime() <= now.getTime());
  if (!delivered.length) return null;

  const today = parts(now, tz);
  const todayDay = dayNumberOf(today.y, today.m, today.d);
  const { start, nextStart } = cycleAround(today, billingDay);
  const daysGone = todayDay - start + 1;
  const daysLeft = nextStart - 1 - todayDay;

  // What has actually been spent this cycle. Known, not estimated.
  let spent = 0;
  const perDay = new Map<number, number>(); // day number (UTC midnights) -> spend
  let earliest = Infinity;
  for (const o of delivered) {
    const at = new Date(o.placedAt);
    const p = parts(at, tz);
    const day = dayNumberOf(p.y, p.m, p.d);
    if (day >= start && day <= todayDay) spent += o.total ?? 0;
    perDay.set(day, (perDay.get(day) ?? 0) + (o.total ?? 0));
    earliest = Math.min(earliest, day);
  }

  const historyDays = todayDay - earliest;
  // Not enough of a record to read a rhythm from. Say nothing rather than
  // invent one (§9.3).
  if (historyDays < FORECAST_MIN_HISTORY_DAYS) return null;

  const shape = { from: isoOf(start), to: isoOf(nextStart - 1), billingDay, daysGone };

  // Nothing left to estimate: the cycle is done, and the answer is what was
  // spent. The range collapses, which is the point.
  if (daysLeft <= 0) {
    return { ...shape, spent, daysLeft: 0, low: spent, mid: spent, high: spent, typicalByNow: typicalBySoFar(perDay, start, daysGone, billingDay, today) };
  }

  // Every stretch of `daysLeft` days the household has been through before,
  // ending before this cycle began, and what each came to. Recent ones count
  // for more.
  const windows: { v: number; w: number }[] = [];
  for (let end = start - 1; end - daysLeft >= earliest; end--) {
    let sum = 0;
    for (let d = end - daysLeft + 1; d <= end; d++) sum += perDay.get(d) ?? 0;
    windows.push({ v: sum, w: Math.pow(2, -(todayDay - end) / FORECAST_HALF_LIFE_DAYS) });
  }
  if (windows.length < FORECAST_MIN_WINDOWS) return null;

  return {
    ...shape,
    spent,
    daysLeft,
    low: spent + weightedQuantile(windows, FORECAST_LOW_QUANTILE),
    mid: spent + weightedQuantile(windows, FORECAST_MID_QUANTILE),
    high: spent + weightedQuantile(windows, FORECAST_HIGH_QUANTILE),
    typicalByNow: typicalBySoFar(perDay, start, daysGone, billingDay, today),
  };
}

// What the household had usually spent this far into a cycle, across the
// cycles the record actually covers. Null when there are fewer than two -
// "usually" needs more than one before.
function typicalBySoFar(
  perDay: Map<number, number>,
  thisStart: number,
  daysGone: number,
  billingDay: number,
  today: { y: number; m: number },
): number | null {
  const totals: number[] = [];
  let y = today.y;
  let m = today.m;
  for (let back = 0; back < 12; back++) {
    const prev = monthBefore(y, m);
    y = prev.y;
    m = prev.m;
    const start = startInMonth(y, m, billingDay);
    if (start >= thisStart) continue;
    // Only a cycle the record actually reaches into.
    if (![...perDay.keys()].some((d) => d >= start && d < start + daysGone)) continue;
    let sum = 0;
    for (let i = 0; i < daysGone; i++) sum += perDay.get(start + i) ?? 0;
    totals.push(sum);
  }
  if (totals.length < 2) return null;
  const s = totals.sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// The day the household's spending month starts, saved. 1 is the calendar
// month; a card billed on the 16th makes the useful window the 16th to the
// 15th, and the forecast then answers about that.
export function setBillingDay(billingDay: number): Promise<{ billingDay: number }> {
  return api('PATCH', '/api/household', { billingDay });
}

// The same product, the same pack, bought on both apps: what each charged.
export interface PriceCompare {
  product: string;
  pack: string; // always known: a comparison without one compares two sizes
  cheaper: string; // vendor
  dearer: string;
  cheaperPrice: number;
  dearerPrice: number;
  saving: number; // per buy, in rupees
  buys: number; // how many purchases stand behind it, both apps together
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// What each app charges for the same thing.
//
// Matched on the product's own name AND its pack, because "butter" on one app
// against "butter" on the other compares a 100 g with a 500 g and calls the
// difference a saving. Each side needs a few purchases behind it, and the gap
// has to be big enough not to be the week's offer (design §9.3: never a
// confident wrong number).
export function comparePrices(orders: ApiOrder[]): PriceCompare[] {
  const byKey = new Map<string, Map<string, number[]>>(); // product·pack -> vendor -> prices
  for (const o of orders.filter(isDelivered)) {
    for (const l of o.items) {
      if (l.pricePaid === null || l.pricePaid <= 0 || !l.count) continue;
      // No pack label, no comparison. Without it "Amul Taaza Toned Milk" on
      // one app is matched against "Amul Taaza Toned Milk" on the other and
      // a 500 ml is called dearer than a 1 L - which is how ₹16 against ₹75
      // looked like a saving on the first run of this.
      if (!l.packLabel) continue;
      const key = `${l.name}||${l.packLabel}`;
      const perVendor = byKey.get(key) ?? new Map<string, number[]>();
      byKey.set(key, perVendor);
      // Per unit, so two of a thing is not read as a dearer thing.
      perVendor.set(o.vendor, [...(perVendor.get(o.vendor) ?? []), l.pricePaid / l.count]);
    }
  }

  const out: PriceCompare[] = [];
  for (const [key, perVendor] of byKey) {
    const sides = [...perVendor.entries()].filter(([, prices]) => prices.length >= INSIGHTS_COMPARE_MIN_BUYS);
    if (sides.length < 2) continue;
    const priced = sides.map(([vendor, prices]) => ({ vendor, price: median(prices), buys: prices.length })).sort((a, b) => a.price - b.price);
    const [low, high] = [priced[0], priced[priced.length - 1]];
    const saving = high.price - low.price;
    if (saving <= 0 || saving < low.price * INSIGHTS_COMPARE_MIN_GAP) continue;
    const [product, pack] = key.split('||');
    out.push({
      product,
      pack,
      cheaper: low.vendor,
      dearer: high.vendor,
      cheaperPrice: low.price,
      dearerPrice: high.price,
      saving,
      buys: low.buys + high.buys,
    });
  }
  // The ones worth the most first: a big gap on something bought often.
  return out.sort((a, b) => b.saving * b.buys - a.saving * a.buys).slice(0, INSIGHTS_COMPARE_SHOWN);
}

export function buildInsights(
  allOrders: ApiOrder[],
  coverage: ApiCoverage[],
  now: Date,
  tz: string,
  rangeDays: number | null = INSIGHTS_DEFAULT_RANGE_DAYS,
  billingDay: number = BILLING_DAY_DEFAULT,
): Insights {
  const at = (o: ApiOrder) => new Date(o.placedAt);

  // Where each app's history starts: read from everything the household has,
  // never from the filtered window, because its whole job is to explain what
  // the window leaves out.
  const earliest = new Map<string, string>();
  for (const o of allOrders) {
    const seen = earliest.get(o.vendor);
    if (!seen || o.placedAt < seen) earliest.set(o.vendor, o.placedAt);
  }
  const history = [...earliest.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([vendor, sinceAt]) => ({ vendor, sinceAt, since: shortDate(new Date(sinceAt), tz) }));

  // Every number below is counted over the chosen window, so the page never
  // puts a 30-day figure beside an all-time one again.
  const orders =
    rangeDays === null ? allOrders : allOrders.filter((o) => at(o).getTime() >= now.getTime() - rangeDays * MS_PER_DAY);
  const sorted = [...orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt));

  // ---- Spend by month: the last INSIGHTS_MONTHS calendar months, this one partial.
  const nowParts = parts(now, tz);
  const keys: string[] = [];
  // A window of N days touches one more calendar month than it spans: 30 days
  // ending mid-September covers part of August too, and a chart of September
  // alone would not add up to the figure above it.
  const monthsShown = rangeDays === null ? INSIGHTS_MONTHS : Math.max(1, Math.min(INSIGHTS_MONTHS, Math.ceil(rangeDays / 30) + 1));
  for (let i = monthsShown - 1; i >= 0; i--) {
    const m0 = nowParts.m - 1 - i;
    const y = nowParts.y + Math.floor(m0 / 12);
    keys.push(monthKey(y, ((m0 % 12) + 12) % 12 + 1));
  }
  const byMonth = new Map(keys.map((k) => [k, { spend: 0, orders: 0 }]));
  for (const o of sorted) {
    const p = parts(at(o), tz);
    const m = byMonth.get(monthKey(p.y, p.m));
    if (!m) continue;
    m.spend += o.total ?? 0;
    m.orders++;
  }
  const months = keys.map((key, i) => ({ key, label: monthLabel(key), ...byMonth.get(key)!, partial: i === keys.length - 1 }));

  // ---- Spend trend: the last N days against the N before.
  const spendBetween = (fromDays: number, toDays: number) =>
    sorted
      .filter((o) => {
        const age = (now.getTime() - at(o).getTime()) / MS_PER_DAY;
        return age >= fromDays && age < toDays;
      })
      .reduce((n, o) => n + (o.total ?? 0), 0);
  // The window against the window before it. All time has no "before", so it
  // falls back to the 30-day trend rather than comparing nothing.
  const trendDays = rangeDays ?? INSIGHTS_TREND_DAYS;
  const recent = spendBetween(0, trendDays);
  // `sorted` is already cut to the window, so the earlier window is counted
  // from everything the household has.
  const beforeSource = rangeDays === null ? sorted : allOrders;
  const before = beforeSource
    .filter((o) => {
      const age = (now.getTime() - at(o).getTime()) / MS_PER_DAY;
      return age >= trendDays && age < 2 * trendDays;
    })
    .reduce((n, o) => n + (o.total ?? 0), 0);
  const trend = { recent, before, changePct: before > 0 ? Math.round(((recent - before) / before) * 100) : null };

  // ---- When: weekday and time of day.
  const weekdays = WEEKDAYS.map((label) => ({ label, orders: 0 }));
  const dayparts = INSIGHTS_DAYPARTS.map((d) => ({ label: d.label, hours: d.hours, orders: 0 }));
  for (const o of sorted) {
    const p = parts(at(o), tz);
    weekdays[p.wd].orders++;
    const i = INSIGHTS_DAYPARTS.findIndex((d) => (d.from < d.to ? p.h >= d.from && p.h < d.to : p.h >= d.from || p.h < d.to));
    dayparts[i].orders++;
  }

  // ---- Items: per canonical item, one purchase per order.
  const items = new Map<string, { emoji: string; category: string; spend: number; dates: Date[]; products: Map<string, { spend: number; buys: number }> }>();
  const baskets: Set<string>[] = [];
  for (const o of sorted) {
    const basket = new Set<string>();
    for (const l of o.items) {
      const c = classifyLine(l);
      if (c.category === 'exclude') continue;
      const it = items.get(c.canonical) ?? { emoji: c.emoji, category: categoryLabel(c.category), spend: 0, dates: [], products: new Map<string, { spend: number; buys: number }>() };
      items.set(c.canonical, it);
      it.spend += l.pricePaid ?? 0;
      // Which product, inside the item. "Noodles, 750" is not an answer when
      // the question is which noodles.
      const label = [l.name, l.packLabel].filter(Boolean).join(' · ');
      const p = it.products.get(label) ?? { spend: 0, buys: 0 };
      p.spend += l.pricePaid ?? 0;
      p.buys += 1;
      it.products.set(label, p);
      if (!basket.has(c.canonical)) it.dates.push(at(o));
      basket.add(c.canonical);
    }
    baskets.push(basket);
  }

  // Where the money goes. By item, not by category: a category averages the
  // story away. "Snacks, 8%" on this household is 81% chocolate; "Pantry, 15%"
  // is mostly olive oil and instant noodles; "Dairy, 18%" is paneer. The
  // household knows what a pantry is - what it does not know is that the
  // chocolate came to twelve thousand rupees.
  const rankedItems = [...items.entries()]
    .map(([name, it]) => ({
      name: displayName(name),
      emoji: it.emoji,
      spend: it.spend,
      // Biggest first, and only the ones worth naming.
      products: [...it.products.entries()]
        .map(([label, p]) => ({ label, spend: p.spend, buys: p.buys }))
        .filter((p) => p.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, INSIGHTS_PRODUCTS_PER_ITEM),
    }))
    .filter((x) => x.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  const spentOnItems = rankedItems.reduce((n, x) => n + x.spend, 0);
  const topSpend = rankedItems.slice(0, INSIGHTS_ITEMS_SHOWN).map((x) => ({
    ...x,
    share: spentOnItems > 0 ? x.spend / spentOnItems : 0,
  }));
  const tail = rankedItems.slice(INSIGHTS_ITEMS_SHOWN);
  const topSpendRest = {
    kinds: tail.length,
    spend: tail.reduce((n, x) => n + x.spend, 0),
    share: spentOnItems > 0 ? tail.reduce((n, x) => n + x.spend, 0) / spentOnItems : 0,
  };

  // Where the money goes, by category.
  const byCategory = new Map<string, number>();
  for (const it of items.values()) byCategory.set(it.category, (byCategory.get(it.category) ?? 0) + it.spend);
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
  // Products the catalog doesn't know yet ("Other") join the small categories
  // as "Everything else": two catch-alls side by side read as a mistake.
  const other = categoryLabel('other');
  const ranked = [...byCategory.entries()].filter(([label]) => label !== other).sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, INSIGHTS_CATEGORIES_SHOWN);
  const rest = ranked.slice(INSIGHTS_CATEGORIES_SHOWN).reduce((n, [, s]) => n + s, 0) + (byCategory.get(other) ?? 0);
  const categories = [...shown, ...(rest > 0 ? [['Everything else', rest] as [string, number]] : [])].map(([label, spend]) => ({
    label,
    spend,
    share: total > 0 ? spend / total : 0,
  }));

  // Rhythm, new habits and stopped items, from the engine's view of each item.
  const gaps = coverageGaps(coverage.map((c) => ({ source: c.vendor, coverageStart: c.coverageStart ? new Date(c.coverageStart) : null })));
  const estimates = [...items.entries()].map(([name, it]) => {
    const purchases: Purchase[] = it.dates.map((d) => ({ at: d, qty: null }));
    return { name, it, e: due(purchases, now, { gaps }) };
  });
  const rhythm = estimates
    .filter((x) => x.e.usualGapDays !== null && x.e.status !== 'STOPPED')
    .sort((a, b) => b.e.trips - a.e.trips || a.name.localeCompare(b.name))
    .slice(0, INSIGHTS_RHYTHM_SHOWN)
    .map((x) => ({ name: displayName(x.name), emoji: x.it.emoji, everyDays: Math.max(1, Math.round(x.e.usualGapDays!)), trips: x.e.trips }));
  // "New" needs history from before the window: otherwise everything is new.
  const historyDays = sorted.length ? (now.getTime() - at(sorted[0]).getTime()) / MS_PER_DAY : 0;
  const newHabits = estimates
    .filter(() => historyDays >= 2 * INSIGHTS_NEW_HABIT_DAYS)
    .filter((x) => x.e.trips >= INSIGHTS_NEW_HABIT_MIN_TRIPS && (now.getTime() - x.it.dates[0].getTime()) / MS_PER_DAY <= INSIGHTS_NEW_HABIT_DAYS)
    .sort((a, b) => b.e.trips - a.e.trips)
    .map((x) => ({ name: displayName(x.name), emoji: x.it.emoji, trips: x.e.trips, since: shortDate(x.it.dates[0], tz) }));
  const stopped = estimates
    .filter((x) => x.e.status === 'STOPPED' && x.e.trips >= INSIGHTS_STOPPED_MIN_TRIPS)
    .sort((a, b) => b.e.trips - a.e.trips)
    .slice(0, INSIGHTS_STOPPED_SHOWN)
    .map((x) => ({
      name: displayName(x.name),
      emoji: x.it.emoji,
      everyDays: Math.max(1, Math.round(x.e.usualGapDays!)),
      lastBought: shortDate(x.it.dates[x.it.dates.length - 1], tz),
    }));

  // Bought together: pairs in the same order far more often than chance.
  const freq = new Map<string, number>();
  for (const b of baskets) for (const i of b) freq.set(i, (freq.get(i) ?? 0) + 1);
  const pairs = new Map<string, number>();
  for (const b of baskets) {
    const list = [...b].filter((i) => (freq.get(i) ?? 0) >= INSIGHTS_TOGETHER_MIN_TIMES).sort();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const k = `${list[i]}\u0000${list[j]}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  const n = baskets.length;
  const together = [...pairs.entries()]
    .filter(([, times]) => times >= INSIGHTS_TOGETHER_MIN_TIMES)
    .map(([k, times]) => {
      const [a, b] = k.split('\u0000');
      return { a: displayName(a), b: displayName(b), times, lift: (times * n) / (freq.get(a)! * freq.get(b)!) };
    })
    .filter((p) => p.lift >= INSIGHTS_TOGETHER_MIN_LIFT)
    .sort((x, y) => y.lift - x.lift || y.times - x.times)
    .slice(0, INSIGHTS_TOGETHER_SHOWN);

  // Who orders: only when more than one person's orders are here.
  const byMember = new Map<string | null, { orders: number; spend: number; name: string | null }>();
  for (const o of sorted) {
    const m = byMember.get(o.by ?? null) ?? { orders: 0, spend: 0, name: null };
    m.orders++;
    m.spend += o.total ?? 0;
    m.name = m.name ?? o.byName ?? null;
    byMember.set(o.by ?? null, m);
  }
  const members =
    byMember.size > 1
      ? [...byMember.entries()]
          .map(([email, { name, ...m }]) => ({ name: memberName(email, false, name), ...m, share: m.orders / sorted.length }))
          .sort((a, b) => b.orders - a.orders)
      : [];

  const forecast = forecastMonth(allOrders, now, tz, billingDay);
  const fees = feesFrom(sorted, tz);

  return {
    orders: sorted.length,
    rangeDays,
    trendDays,
    history,
    months,
    // From everything the household has, not the filtered window: this month
    // is being compared against the household's own past, and narrowing the
    // past to a year of it would only make the estimate worse.
    forecast,
    trend,
    weekdays,
    dayparts,
    categories,
    topSpend,
    topSpendRest,
    rhythm,
    together,
    compare: comparePrices(sorted),
    newHabits,
    stopped,
    members,
    fees,
    advice: adviceFor(allOrders, { now, tz, cycle: forecast ? { from: forecast.from, to: forecast.to } : null, feePerOrder: fees?.perOrder ?? null }),
  };
}

// What the page must say when the apps hold different amounts of history
// (Instamart serves a rolling 12 months, design Appendix C; Blinkit keeps
// years, Appendix A). Two different traps:
//   - the window itself reaches past an app's first order, so its totals are
//     smaller for a reason that has nothing to do with shopping;
//   - the window fits, but the period it is COMPARED against does not, which
//     is worse: the change reads as a real swing in spending when it is only
//     one app's history running out. A live example on 2026-09-20 showed
//     "+154%" for exactly that reason.
// Null when every app covers the whole comparison: then the numbers are fair
// and the page should not clutter itself explaining nothing.
export function unevenHistoryNote(
  history: Insights['history'],
  rangeDays: number | null,
  trendDays: number,
  now: Date,
  nameOf: (vendor: string) => string = (v) => v,
): string | null {
  if (history.length < 2) return null;
  const daysOf = (sinceAt: string) => (now.getTime() - new Date(sinceAt).getTime()) / MS_PER_DAY;
  const shortest = history.reduce((least, h) => Math.min(least, daysOf(h.sinceAt)), Infinity);
  // Name only the app whose history is the short one: it is the one the
  // sentence is about, and listing every app made this three lines long and
  // pushed the point under the fold.
  const short = history.reduce((a, h) => (daysOf(h.sinceAt) < daysOf(a.sinceAt) ? h : a));
  const starts = `${nameOf(short.vendor)} orders here start ${short.since}`;
  if (rangeDays === null || rangeDays > shortest) {
    return `${starts}, so over this window the apps are not a fair comparison.`;
  }
  if (2 * trendDays > shortest) {
    return `${starts}. The period compared against reaches before that, so part of this change is one app's history running out.`;
  }
  return null;
}
