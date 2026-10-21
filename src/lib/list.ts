import { EVERYDAY_GAP_DAYS } from './constants';

// Showing only the top few items of a long list, most likely first; the rest
// sit behind "Show N more".

// The order of the running-low list: the items bought most often first
// (shortest usual gap), then the least overdue, then the fewest days left.
// Measured on real history (spike/merge/backtest.ts): the top 3 went from 25%
// right (fewest days left first) to 59%. Items with no usual gap go last. A
// stable sort, so full ties keep their order.
export interface Rankable {
  usualGapDays?: number | null;
  dueRatio?: number | null;
  daysUntilLow: number | null;
}

export function compareLikely(a: Rankable, b: Rankable): number {
  const key = (x: number | null | undefined) => x ?? Infinity;
  return key(a.usualGapDays) - key(b.usualGapDays) || key(a.dueRatio) - key(b.dueRatio) || key(a.daysUntilLow) - key(b.daysUntilLow);
}

export function mostLikelyFirst<T extends Rankable>(items: T[]): T[] {
  return [...items].sort(compareLikely);
}

// Bought most days (milk, bread, curd): the flag is right and tells nobody
// anything, because the answer is always yes. Split out so the list can show
// them apart from the alerts that do carry information.
export function isEverydayItem(item: Rankable, gapDays: number = EVERYDAY_GAP_DAYS): boolean {
  return item.usualGapDays !== null && item.usualGapDays !== undefined && item.usualGapDays <= gapDays;
}

// The running-low list in two parts, each most likely first: what to look at,
// and what the household buys anyway.
export function splitEveryday<T extends Rankable>(items: T[], gapDays: number = EVERYDAY_GAP_DAYS): { alerts: T[]; everyday: T[] } {
  const sorted = mostLikelyFirst(items);
  return {
    alerts: sorted.filter((i) => !isEverydayItem(i, gapDays)),
    everyday: sorted.filter((i) => isEverydayItem(i, gapDays)),
  };
}

export function splitTop<T>(items: T[], n: number): { shown: T[]; hidden: T[] } {
  return { shown: items.slice(0, n), hidden: items.slice(n) };
}

// "Milk, Bread, Eggs and 2 more"
export function summarizeNames(names: string[], n: number): string {
  const { shown, hidden } = splitTop(names, n);
  return hidden.length ? `${shown.join(', ')} and ${hidden.length} more` : shown.join(', ');
}
