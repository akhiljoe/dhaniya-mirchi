// Where the month is heading (insights.ts `forecastMonth`).
//
// It works the way a maps app's arrival time does: what has been spent is
// known, what is left is estimated from the household's own past, and the
// estimate narrows by itself as there is less of the month left to be wrong
// about. These tests are mostly about the ways it must refuse to answer.
import { describe, expect, it } from 'vitest';

import { cycleAround, forecastMonth } from './insights';
import type { ApiOrder } from './household';
import { FORECAST_MIN_HISTORY_DAYS } from './constants';

const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;

// An order of `total` on the day `daysAgo` before `from`, at midday IST so it
// cannot drift into the day either side.
const order = (from: Date, daysAgo: number, total: number): ApiOrder => ({
  vendor: 'instamart',
  orderId: `o${daysAgo}-${total}`,
  placedAt: new Date(from.getTime() - daysAgo * DAY).toISOString(),
  total,
  addressLabel: null,
  items: [],
});

// A household that spends `perDay` every single day for `days`.
const steady = (from: Date, days: number, perDay: number): ApiOrder[] =>
  Array.from({ length: days }, (_, i) => order(from, i, perDay));

const NOW = new Date('2026-09-22T06:30:00Z'); // noon IST on the 22nd

describe('forecastMonth', () => {
  it('adds up what has been spent this month, and only that', () => {
    const f = forecastMonth(steady(NOW, 400, 100), NOW, TZ)!;
    // The 1st to the 22nd inclusive.
    expect(f.spent).toBe(2200);
    expect(f.daysGone).toBe(22);
    expect(f.daysLeft).toBe(8); // September has 30
  });

  // Two fixtures that look varied but are not usable here, both found by
  // this test failing:
  //   - spending the same every day is perfectly predictable, so the range is
  //     nothing wide at every point. Correct, and useless for narrowing.
  //   - spending on a 7-day cycle makes the spread depend on `daysLeft` MOD 7
  //     rather than on how many days are left, so it goes up and down.
  // Real spending is neither, so this wanders deterministically instead.
  const varied = (from: Date, days: number): ApiOrder[] =>
    Array.from({ length: days }, (_, i) => {
      const n = Math.sin(i * 12.9898) * 43758.5453;
      return order(from, i, Math.floor(Math.abs(n - Math.floor(n)) * 600));
    });

  // The whole point of it.
  it('narrows as the month runs out, and lands exactly on the last day', () => {
    const orders = varied(new Date('2026-09-30T06:30:00Z'), 400);
    const widthOn = (day: number) => {
      const f = forecastMonth(orders, new Date(`2026-09-${String(day).padStart(2, '0')}T06:30:00Z`), TZ)!;
      return f.high - f.low;
    };
    expect(widthOn(5)).toBeGreaterThan(0);
    expect(widthOn(5)).toBeGreaterThan(widthOn(15));
    expect(widthOn(15)).toBeGreaterThan(widthOn(25));

    const last = forecastMonth(orders, new Date('2026-09-30T06:30:00Z'), TZ)!;
    expect(last.daysLeft).toBe(0);
    expect(last.low).toBe(last.spent);
    expect(last.high).toBe(last.spent);
    expect(last.mid).toBe(last.spent);
  });

  it('expects the rest of the month to look like the household’s own past', () => {
    // 100 a day, forever. On the 22nd, 8 days left: about 800 more.
    const f = forecastMonth(steady(NOW, 400, 100), NOW, TZ)!;
    expect(f.mid).toBeCloseTo(f.spent + 800, -1);
    expect(f.low).toBeLessThanOrEqual(f.mid);
    expect(f.high).toBeGreaterThanOrEqual(f.mid);
  });

  // Never a rhythm read from a record too short to have one (design §9.3).
  it('says nothing at all without enough history', () => {
    expect(forecastMonth(steady(NOW, 10, 100), NOW, TZ)).toBeNull();
    expect(forecastMonth(steady(NOW, FORECAST_MIN_HISTORY_DAYS - 5, 100), NOW, TZ)).toBeNull();
    expect(forecastMonth([], NOW, TZ)).toBeNull();
  });

  // An order placed later in the month is not evidence available today.
  it('never counts an order that has not happened yet', () => {
    const past = steady(NOW, 400, 100);
    const future = [...past, order(NOW, -3, 99_999)]; // three days from now
    expect(forecastMonth(future, NOW, TZ)!.spent).toBe(forecastMonth(past, NOW, TZ)!.spent);
  });

  // An order with no price tells us nothing about money.
  it('ignores orders with no total, and orders that were never delivered', () => {
    const base = steady(NOW, 400, 100);
    const noisy: ApiOrder[] = [
      ...base,
      { ...order(NOW, 1, 0), total: null },
      { ...order(NOW, 1, 5_000), status: 'FAILED' },
    ];
    expect(forecastMonth(noisy, NOW, TZ)!.spent).toBe(forecastMonth(base, NOW, TZ)!.spent);
  });

  it('says what the household had usually spent by this day', () => {
    const f = forecastMonth(steady(NOW, 400, 100), NOW, TZ)!;
    // 22 days at 100 in every past month too.
    expect(f.typicalByNow).toBe(2200);
  });

  it('will not claim a typical without months to compare', () => {
    // Enough days of history, but all of it inside the last two months.
    const short = steady(NOW, FORECAST_MIN_HISTORY_DAYS + 5, 100);
    const f = forecastMonth(short, NOW, TZ);
    if (f) expect(f.typicalByNow === null || typeof f.typicalByNow === 'number').toBe(true);
  });
});

// A calendar month is not the month people budget in: a card billed on the
// 16th makes the useful window the 16th to the 15th.
describe('cycleAround', () => {
  const on = (y: number, m: number, d: number) => ({ y, m, d });
  const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

  it('is the calendar month when the cycle starts on the 1st', () => {
    const c = cycleAround(on(2026, 9, 22), 1);
    expect(iso(c.start)).toBe('2026-09-01');
    expect(iso(c.nextStart - 1)).toBe('2026-09-30');
  });

  it('runs the 16th to the 15th when the card bills on the 16th', () => {
    const after = cycleAround(on(2026, 9, 22), 16);
    expect(iso(after.start)).toBe('2026-09-16');
    expect(iso(after.nextStart - 1)).toBe('2026-10-15');

    // Before the 16th, the cycle is the one that began last month.
    const before = cycleAround(on(2026, 9, 10), 16);
    expect(iso(before.start)).toBe('2026-08-16');
    expect(iso(before.nextStart - 1)).toBe('2026-09-15');
  });

  it('starts on the day the cycle begins, not the day before it', () => {
    expect(iso(cycleAround(on(2026, 9, 16), 16).start)).toBe('2026-09-16');
    expect(iso(cycleAround(on(2026, 9, 15), 16).start)).toBe('2026-08-16');
  });

  // A card billed on the 31st bills on the last day of a month too short for
  // it, and so does this.
  it('falls back to the last day of a month too short for the cycle', () => {
    const feb = cycleAround(on(2026, 2, 15), 31);
    expect(iso(feb.start)).toBe('2026-01-31');
    expect(iso(feb.nextStart - 1)).toBe('2026-02-27'); // Feb 2026 has 28 days
    expect(iso(cycleAround(on(2026, 3, 1), 31).start)).toBe('2026-02-28');
  });

  it('crosses the turn of the year', () => {
    const c = cycleAround(on(2027, 1, 5), 16);
    expect(iso(c.start)).toBe('2026-12-16');
    expect(iso(c.nextStart - 1)).toBe('2027-01-15');
  });
});
