// When will the household buy an item next (design §9.6)? Pure, no I/O: the
// caller hands in the purchases, the gaps, the away periods and `now`.
// Tunables live in ./constants.
//
// The stock estimate (estimate.ts) answers "how much is left". This answers
// the question the "running low" list is scored on: "will they need to buy it
// in the next few days?" It reads the household's own buying rhythm, as an
// empirical, recency-weighted survival estimate over the gaps between trips:
//
//   s        = days at home since the item was last bought
//   risk     = Σ w over past gaps longer than s     (gaps that "were still open" at s)
//   bought   = Σ w over those that closed within (s, s + horizon]
//   P(buy within horizon) = bought / (risk + prior)
//
// Measured on real history (spike/db/experiment.ts, design §17): the same
// recall as the stock-based status with a third fewer flags, and flags that
// expire on their own once an item is past every gap it has ever had.
import {
  DUE_COMING_UP_HORIZON_MULTIPLE,
  DUE_HALF_LIFE_DAYS,
  DUE_HORIZON_DAYS,
  DUE_HORIZON_GAP_FRACTION,
  DUE_HORIZON_MIN_DAYS,
  DUE_MIN_INTERVALS,
  DUE_QUIET_FRACTION,
  DUE_QUIET_MAX_DAYS,
  DUE_MIN_LIKELIHOOD,
  DUE_OVERDUE_GAPS,
  DUE_PRIOR_WEIGHT,
  DUE_TRIP_MERGE_HOURS,
  MS_PER_DAY,
} from './constants';
import { mergeAway, spanDaysBetween } from './away';
import { overlapsGap } from './coverage';
import { gapScale, type ScalesWith } from './size';
import type { AnalyzeOptions, Purchase, RegularUse } from './types';

const MS_PER_HOUR = MS_PER_DAY / 24;

export type DueStatus = 'BUY_SOON' | 'RUNNING_LOW' | 'AVAILABLE' | 'STOPPED' | 'UNKNOWN';

export interface DueEstimate {
  trips: number; // shopping trips that bought it (purchases closer than DUE_TRIP_MERGE_HOURS are one)
  intervals: number; // gaps between trips that feed the estimate
  droppedForPrompted: number; // gaps that start or end at a purchase we suggested
  droppedForGaps: number; // gaps overlapping a coverage gap
  shortenedForAway: number; // gaps with away days taken out
  usualGapDays: number | null; // recency-weighted median gap
  daysSinceLast: number | null; // days at home since the last trip
  likelihood: number | null; // P(bought within the horizon); null = not enough history
  likelihoodLater: number | null; // the same over DUE_COMING_UP_HORIZON_MULTIPLE × the horizon
  // Days until buying it becomes likely (the chance reaches DUE_MIN_LIKELIHOOD):
  // the same test the list uses, so "coming up in ~6 days" agrees with it.
  // Never that likely → the typical wait (weighted median of the open gaps).
  daysToNext: number | null;
  beyondHistory: boolean; // longer than every gap it has ever had
  status: DueStatus;
}

// What the caller knows about the item itself (design §9.12).
export interface DueItem {
  scalesWith?: ScalesWith; // omitted: its gaps are never rescaled
  regular?: RegularUse[]; // standing daily use the household told us about
}

interface Trip {
  at: number;
  prompted: boolean;
  qty: number | null; // summed; unknown if any purchase's is
}

// Purchases within DUE_TRIP_MERGE_HOURS of a trip's first purchase are that
// trip: two orders an hour apart (or two members' orders on one afternoon)
// are one restock, not two. A trip with any prompted purchase is prompted.
function tripsOf(purchases: Purchase[]): Trip[] {
  const sorted = [...purchases].sort((a, b) => a.at.getTime() - b.at.getTime());
  const trips: Trip[] = [];
  for (const p of sorted) {
    const last = trips[trips.length - 1];
    if (last && p.at.getTime() - last.at < DUE_TRIP_MERGE_HOURS * MS_PER_HOUR) {
      last.prompted = last.prompted || !!p.prompted;
      last.qty = last.qty === null || p.qty === null ? null : last.qty + p.qty;
      continue;
    }
    trips.push({ at: p.at.getTime(), prompted: !!p.prompted, qty: p.qty });
  }
  return trips;
}

function weightedMedian(xs: { v: number; w: number }[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a.v - b.v);
  const half = s.reduce((n, x) => n + x.w, 0) / 2;
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= half) return x.v;
  }
  return s[s.length - 1].v;
}

// Invariants (design §9.2, §9.3, §9.10, §9.11):
//  - A gap that starts or ends at a PROMPTED trip never feeds the estimate:
//    its timing is our own suggestion, and using it would let the list
//    confirm itself. The prompted trip still counts as "last bought" — the
//    household did buy it.
//  - The horizon given is a CAP, not the window: an item whose own gap is
//    shorter is judged on half of that gap instead (never under a day). A
//    flat horizon swallows a fast item whole - bread bought every 2 days is
//    "likely bought within 4 days" the hour it is delivered - so the list
//    said buy bread on the day the bread came, every day, forever.
//  - For DUE_QUIET_FRACTION of its own gap after a trip (at most
//    DUE_QUIET_MAX_DAYS), an item is never BUY_SOON: it was just bought, so
//    it is in the house. It still says when it comes due. Only a daily amount
//    the household told us can override that.
//  - Fewer than DUE_MIN_INTERVALS gaps → likelihood null, status UNKNOWN.
//    Never a rhythm borrowed from another item, household or category.
//  - A gap overlapping a coverage gap is dropped: trips may hide inside it.
//  - Away days are taken out of gaps and out of s: nothing is bought or used
//    while nobody is home. A gap with no home days left is dropped.
//  - Past every gap it has ever had (no gap longer than s): BUY_SOON while
//    within DUE_OVERDUE_GAPS usual gaps (late, still needed); beyond that
//    STOPPED, never flagged: the household stopped buying it or buys it
//    elsewhere.
//  - Household size (design §9.12): with `opts.sizes` and `item.scalesWith`,
//    each past gap is rescaled to today's household, gap × size(then) /
//    size(now). Unknown size at either end → the gap as it was.
//  - Regular use the household told us (design §9.12), active at `now`:
//    any of it → never STOPPED (it is used every day); a stated amount a day
//    → a floor: once the last trip's quantity is used up at that rate (less
//    the horizon), BUY_SOON whatever the rhythm says. The floor needs the
//    last trip's quantity; unknown → no floor, never a guessed one.
export function due(
  purchases: Purchase[],
  now: Date,
  opts: AnalyzeOptions = {},
  horizonDays = DUE_HORIZON_DAYS,
  item: DueItem = {},
): DueEstimate {
  const trips = tripsOf(purchases.filter((p) => p.at.getTime() <= now.getTime()));
  const away = mergeAway(opts.away ?? [], now);
  const gaps = opts.gaps ?? [];
  const base: DueEstimate = {
    trips: trips.length,
    intervals: 0,
    droppedForPrompted: 0,
    droppedForGaps: 0,
    shortenedForAway: 0,
    usualGapDays: null,
    daysSinceLast: null,
    likelihood: null,
    likelihoodLater: null,
    daysToNext: null,
    beyondHistory: false,
    status: 'UNKNOWN',
  };
  if (!trips.length) return base;

  const last = trips[trips.length - 1];
  const s = (now.getTime() - last.at) / MS_PER_DAY - spanDaysBetween(new Date(last.at), now, away);
  base.daysSinceLast = s;

  // Each gap as measured (days at home), with the moment it describes (its
  // midpoint, for the household size then) and its recency weight.
  const raw: { days: number; mid: Date; w: number }[] = [];
  for (let i = 1; i < trips.length; i++) {
    const a = new Date(trips[i - 1].at);
    const b = new Date(trips[i].at);
    if (trips[i - 1].prompted || trips[i].prompted) {
      base.droppedForPrompted++;
      continue;
    }
    if (gaps.some((g) => overlapsGap(a, b, g))) {
      base.droppedForGaps++;
      continue;
    }
    const awayDays = spanDaysBetween(a, b, away);
    const days = (b.getTime() - a.getTime()) / MS_PER_DAY - awayDays;
    if (days <= 0) continue;
    if (awayDays > 0) base.shortenedForAway++;
    const age = (now.getTime() - b.getTime()) / MS_PER_DAY;
    raw.push({ days, mid: new Date((a.getTime() + b.getTime()) / 2), w: Math.pow(2, -age / DUE_HALF_LIFE_DAYS) });
  }
  base.intervals = raw.length;

  // The gaps rescaled to the household over the next `ahead` days (§9.12):
  // guests arriving inside the window make every gap shorter.
  const sizes = opts.sizes ?? [];
  const scaled = (ahead: number) =>
    raw.map((o) => ({ v: o.days * (item.scalesWith && sizes.length ? gapScale(sizes, o.mid, now, item.scalesWith, ahead) : 1), w: o.w }));

  // Regular use active now, and the floor a stated daily amount sets: the
  // last trip's quantity lasts at most this many days.
  const active = (item.regular ?? []).filter((r) => r.from.getTime() <= now.getTime() && (r.to === null || r.to.getTime() > now.getTime()));
  const perDay = active.reduce((n, r) => n + (r.perDay ?? 0), 0);
  const floorDays = perDay > 0 && last.qty !== null ? last.qty / perDay : null;
  const floorDue = floorDays !== null && s >= floorDays - horizonDays;

  if (raw.length < DUE_MIN_INTERVALS) {
    // No rhythm yet; a stated daily amount can still say it is due.
    if (floorDue) {
      base.status = 'BUY_SOON';
      base.daysToNext = Math.max(0, floorDays! - s);
    }
    return base;
  }

  const likelihoodWithin = (h: number) => {
    const open = scaled(h).filter((o) => o.v > s);
    const risk = open.reduce((n, o) => n + o.w, 0);
    return open.filter((o) => o.v <= s + h).reduce((n, o) => n + o.w, 0) / (risk + DUE_PRIOR_WEIGHT);
  };
  // The horizon the item is judged on. `horizonDays` is the cap - the furthest
  // ahead the list ever looks - but an item that comes round faster is judged
  // on its own rhythm (§9.6). Without this a flat horizon swallows whole
  // cycles of a fast item: bread bought every 2 days is "likely bought within
  // 4 days" the hour it is delivered, so the list said buy bread on the day
  // the bread arrived, every day, forever.
  base.usualGapDays = weightedMedian(scaled(horizonDays));
  const horizon = Math.max(DUE_HORIZON_MIN_DAYS, Math.min(horizonDays, base.usualGapDays! * DUE_HORIZON_GAP_FRACTION));
  const ahead = scaled(horizon);
  const open = ahead.filter((o) => o.v > s);
  base.likelihood = likelihoodWithin(horizon);
  base.likelihoodLater = likelihoodWithin(horizon * DUE_COMING_UP_HORIZON_MULTIPLE);
  const need = DUE_MIN_LIKELIHOOD * (open.reduce((n, o) => n + o.w, 0) + DUE_PRIOR_WEIGHT);
  let acc = 0;
  base.daysToNext = null;
  for (const o of [...open].sort((a, b) => a.v - b.v)) {
    acc += o.w;
    if (acc >= need) {
      base.daysToNext = o.v - s;
      break;
    }
  }
  base.daysToNext ??= weightedMedian(open.map((o) => ({ v: o.v - s, w: o.w })));
  base.beyondHistory = open.length === 0;
  // Late, but not by much: a steady item a day past its longest gap is due,
  // not stopped. Only well past its usual gap does it count as stopped.
  // Used every day (regular use): past its gaps it is late, never stopped.
  const overdue = base.beyondHistory && (active.length > 0 || s <= DUE_OVERDUE_GAPS * base.usualGapDays!);
  if (overdue) base.daysToNext = 0;
  if (floorDays !== null) base.daysToNext = Math.min(base.daysToNext ?? Infinity, Math.max(0, floorDays - s));
  // Bought within the quiet window: it is in the house, so the list says
  // "coming up" and when, never "buy". A household's own daily amount
  // (floorDue) overrides it - they told us how fast it goes, and a trip that
  // bought less than a day of it is genuinely due.
  const quiet = s < Math.min(DUE_QUIET_MAX_DAYS, base.usualGapDays! * DUE_QUIET_FRACTION);
  base.status = overdue || floorDue
    ? 'BUY_SOON'
    : base.beyondHistory
    ? 'STOPPED'
    : base.likelihood >= DUE_MIN_LIKELIHOOD && !quiet
      ? 'BUY_SOON'
      : base.likelihood >= DUE_MIN_LIKELIHOOD || base.likelihoodLater >= DUE_MIN_LIKELIHOOD
        ? 'RUNNING_LOW'
        : 'AVAILABLE';
  return base;
}
