// The backtest (design §17): replay the app day by day over real history and
// score its "running low" flags against what the household bought next.
//
//   precision: of the items flagged on a day, the share bought within the
//              horizon after. Low precision = nagging.
//   precision@3: the same, for only the top 3 of each day in the app's order
//              (the ones Home shows first).
//   recall:    of the purchases of items the app already knew (bought at least
//              twice before), the share flagged within the horizon before.
//              Low recall = running out unwarned.
//
// Runs the same pipeline as the pages (buildHousehold), on only the orders
// placed before each day, so nothing from the future leaks in.
import { classifyLine, isStock } from '@/catalog/classify';

import { buildHousehold, type ApiCoverage, type ApiOrder, type HouseholdProfile } from './household';
import { HOME_LOW_ITEMS_VISIBLE } from './constants';
import { mostLikelyFirst } from './list';

const MS_PER_DAY = 86_400_000;
// Home shows this many running-low items before "Show more".
const TOP = HOME_LOW_ITEMS_VISIBLE;

export interface BacktestResult {
  days: number;
  flags: number;
  hits: number;
  precision: number | null;
  precisionAt3: number | null;
  flagsPerDay: number;
  purchases: number;
  caught: number;
  recall: number | null;
  byItem: { item: string; flags: number; hits: number; misses: number }[]; // most misses first
}

export function backtest(
  orders: ApiOrder[],
  coverage: ApiCoverage[],
  tz: string,
  from: Date,
  to: Date,
  opts: { stepDays: number; horizonDays: number; profile?: HouseholdProfile },
): BacktestResult {
  const sorted = [...orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt));
  // Each order's canonical items, classified once.
  const bought = sorted.map((o) => ({
    at: new Date(o.placedAt).getTime(),
    items: new Set(o.items.map((l) => classifyLine(l)).filter(isStock).map((c) => c.canonical)),
  }));
  const horizon = opts.horizonDays * MS_PER_DAY;
  const boughtWithin = (item: string, start: number, end: number) => bought.some((b) => b.at > start && b.at <= end && b.items.has(item));

  const flaggedOn: { t: number; items: Set<string> }[] = [];
  const perItem = new Map<string, { flags: number; hits: number }>();
  let flags = 0;
  let hits = 0;
  let top = 0;
  let topHits = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += opts.stepDays * MS_PER_DAY) {
    const visible = sorted.filter((o) => new Date(o.placedAt).getTime() < t);
    const h = buildHousehold(visible, coverage, new Date(t), tz, opts.profile);
    const low = h.inventory.filter((i) => i.status === 'likely-low');
    const items = new Set(low.map((i) => i.id));
    flaggedOn.push({ t, items });
    for (const i of mostLikelyFirst(low).slice(0, TOP)) {
      top++;
      if (boughtWithin(i.id, t, t + horizon)) topHits++;
    }
    for (const item of items) {
      const hit = boughtWithin(item, t, t + horizon);
      flags++;
      if (hit) hits++;
      const s = perItem.get(item) ?? { flags: 0, hits: 0 };
      s.flags++;
      if (hit) s.hits++;
      perItem.set(item, s);
    }
  }

  // Purchases the app could have seen coming: the item bought at least twice
  // before, and the purchase inside the replayed window with a full horizon.
  let purchases = 0;
  let caught = 0;
  const seen = new Map<string, number>();
  for (const b of bought) {
    for (const item of b.items) {
      const before = seen.get(item) ?? 0;
      if (before >= 2 && b.at - horizon >= from.getTime() && b.at <= to.getTime()) {
        purchases++;
        if (flaggedOn.some((f) => f.t >= b.at - horizon && f.t < b.at && f.items.has(item))) caught++;
      }
      seen.set(item, before + 1);
    }
  }

  const days = flaggedOn.length;
  return {
    days,
    flags,
    hits,
    precision: flags ? hits / flags : null,
    precisionAt3: top ? topHits / top : null,
    flagsPerDay: days ? flags / days : 0,
    purchases,
    caught,
    recall: purchases ? caught / purchases : null,
    byItem: [...perItem.entries()]
      .map(([item, s]) => ({ item, flags: s.flags, hits: s.hits, misses: s.flags - s.hits }))
      .sort((a, b) => b.misses - a.misses || a.item.localeCompare(b.item)),
  };
}
