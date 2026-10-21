// The date range a page is read over (design §12.7), shared by the pages that
// offer one so they all mean the same thing by "3 months".
//
// The range is what the household READS, never what the engine computes from.
// Rates, usual gaps and the running-low list are built from every order we
// hold (src/lib/household.ts): narrowing those to a window would quietly make
// predictions worse, which is exactly the silent degrading the engine must
// never do. So these helpers filter lists for display and nothing else.
import { useEffect, useState } from 'react';

import { RANGE_OPTIONS } from './constants';

const MS_PER_DAY = 86_400_000;

export type RangeDays = number | null; // null = everything we have

export function withinRange<T extends { at: string }>(rows: T[], rangeDays: RangeDays, now: Date): T[] {
  if (rangeDays === null) return rows;
  const cutoff = now.getTime() - rangeDays * MS_PER_DAY;
  return rows.filter((r) => new Date(r.at).getTime() >= cutoff);
}

// "the last 3 months", for the middle of a sentence.
export function rangeText(days: RangeDays): string {
  if (days === null) return 'all time';
  const option = RANGE_OPTIONS.find((r) => r.days === days);
  return option ? `the last ${option.label}` : `the last ${days} days`;
}

// The choice is remembered per person, in this browser, so reopening the app
// on a phone does not throw it away. Storage can be blocked or empty, and the
// page must render either way.
export function useRememberedRange(key: string, fallback: RangeDays): [RangeDays, (days: RangeDays) => void] {
  const [days, setDays] = useState<RangeDays>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === null) return fallback;
      if (saved === 'all') return null;
      const n = Number(saved);
      return RANGE_OPTIONS.some((r) => r.days === n) ? n : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, days === null ? 'all' : String(days));
    } catch {
      // A private window, or storage turned off: the choice just lasts the session.
    }
  }, [key, days]);

  return [days, setDays];
}
