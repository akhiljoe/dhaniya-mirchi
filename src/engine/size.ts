// Who lives in the household, over time (design §9.12). Pure: the caller hands
// in the facts; nothing here reads a clock or a database.
//
// A gap between two purchases learned while 2 people lived here says less
// about today, with 4, than one learned last week. Food use scales with the
// people eating it, so a past gap is rescaled to the household it is used
// for: gap × size(then) / size(ahead), where "ahead" is the largest household
// in the window being predicted — guests arriving in two days count now. Pet
// items scale with the pets. A size unknown at either end → no rescaling
// (factor 1): never an invented head count.
import { MS_PER_DAY } from './constants';
import type { HouseholdSize } from './types';

export type ScalesWith = 'people' | 'pets';

// The household facts that set its size (design §9.12). Dates are instants
// (the caller turns the household's local dates into them); guests' `to` is
// exclusive.
export interface SizeFacts {
  people: { from: Date; count: number }[];
  pets: { from: Date; count: number }[];
  guests: { from: Date; to: Date; count: number }[];
}

// The step timeline the engine reads: one entry per moment anything changes,
// each holding until the next. Before the first `people` fact the head count
// is unknown (0 = unknown, never scaled); guests only add to a known count.
export function sizeTimeline(f: SizeFacts): HouseholdSize[] {
  const times = new Set<number>();
  for (const p of f.people) times.add(p.from.getTime());
  for (const p of f.pets) times.add(p.from.getTime());
  for (const g of f.guests) {
    times.add(g.from.getTime());
    times.add(g.to.getTime());
  }
  const latest = (xs: { from: Date; count: number }[], t: number) => {
    let best: { from: Date; count: number } | null = null;
    for (const x of xs) if (x.from.getTime() <= t && (!best || x.from.getTime() >= best.from.getTime())) best = x;
    return best;
  };
  return [...times]
    .sort((a, b) => a - b)
    .map((t) => {
      const residents = latest(f.people, t);
      const guests = f.guests.filter((g) => g.from.getTime() <= t && g.to.getTime() > t).reduce((n, g) => n + g.count, 0);
      return {
        from: new Date(t),
        people: residents ? residents.count + guests : 0,
        pets: latest(f.pets, t)?.count ?? 0,
      };
    });
}

// The household's size at `t`: the latest entry that started on or before it.
// Before the first entry, or a count of 0, it is unknown (null).
export function sizeAt(sizes: HouseholdSize[], t: Date, who: ScalesWith): number | null {
  let found: HouseholdSize | null = null;
  for (const s of sizes) {
    if (s.from.getTime() <= t.getTime() && (!found || s.from.getTime() >= found.from.getTime())) found = s;
  }
  const n = found ? (who === 'people' ? found.people : found.pets) : 0;
  return n > 0 ? n : null;
}

// The largest household in [now, now + days]: the one the next purchase has
// to cover. Unknown now → unknown.
export function sizeAhead(sizes: HouseholdSize[], now: Date, days: number, who: ScalesWith): number | null {
  const start = sizeAt(sizes, now, who);
  if (start === null) return null;
  const end = now.getTime() + days * MS_PER_DAY;
  let max = start;
  for (const s of sizes) {
    const t = s.from.getTime();
    if (t > now.getTime() && t <= end) max = Math.max(max, sizeAt(sizes, s.from, who) ?? 0);
  }
  return max;
}

// How long a past gap would be for the household ahead: size(then) / size(ahead).
// 1 when either is unknown.
export function gapScale(sizes: HouseholdSize[], then: Date, now: Date, who: ScalesWith, aheadDays = 0): number {
  const a = sizeAt(sizes, then, who);
  const b = sizeAhead(sizes, now, aheadDays, who);
  if (!a || !b) return 1;
  return a / b;
}

// How much faster (> 1) the household uses things now than when a rate was
// learned: size(now) / size(then). 1 when either is unknown.
export function rateScale(sizes: HouseholdSize[], then: Date, now: Date, who: ScalesWith): number {
  const a = sizeAt(sizes, then, who);
  const b = sizeAt(sizes, now, who);
  if (!a || !b) return 1;
  return b / a;
}
