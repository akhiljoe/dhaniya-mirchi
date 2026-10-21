// Household away periods (design §9.11). Pure: the caller loads the periods;
// `now` resolves an ongoing one. Tunables live in ./constants.
import { CATEGORY_SHELF_LIFE, MIN_AWAY_DAYS, MS_PER_DAY, NON_PERISHABLE } from './constants';
import type { AwayPeriod } from './types';

export interface Span {
  from: number; // epoch ms
  to: number;
}

// Resolve ongoing periods to `now`, drop ones shorter than MIN_AWAY_DAYS
// (noise), then merge overlaps so no day is ever counted twice.
export function mergeAway(away: AwayPeriod[], now: Date): Span[] {
  const spans = away
    .map((a) => ({ from: a.from.getTime(), to: (a.to ?? now).getTime() }))
    .filter((s) => (s.to - s.from) / MS_PER_DAY >= MIN_AWAY_DAYS)
    .sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return merged;
}

const overlapMs = (start: number, end: number, s: Span) => Math.max(0, Math.min(end, s.to) - Math.max(start, s.from));

// Total days of [start, end] the household was away.
export function awayDaysBetween(start: Date, end: Date, away: AwayPeriod[], now: Date): number {
  return spanDaysBetween(start, end, mergeAway(away, now));
}

export function spanDaysBetween(start: Date, end: Date, spans: Span[]): number {
  const a = start.getTime();
  const b = end.getTime();
  return spans.reduce((sum, s) => sum + overlapMs(a, b, s), 0) / MS_PER_DAY;
}

// The longest single continuous absence inside [start, end], in days — what
// decides whether perishables left at home spoiled.
export function longestSpanDaysBetween(start: Date, end: Date, spans: Span[]): number {
  const a = start.getTime();
  const b = end.getTime();
  return spans.reduce((max, s) => Math.max(max, overlapMs(a, b, s)), 0) / MS_PER_DAY;
}

// Perishability + shelf life for a category, used when an item has no override.
export function categoryDefaults(category: string): { perishable: boolean; shelfLifeDays: number | null } {
  return { ...(CATEGORY_SHELF_LIFE[category] ?? NON_PERISHABLE) };
}
