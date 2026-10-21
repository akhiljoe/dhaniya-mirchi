// Household away (design §9.11): while the household is away nothing is
// consumed and nothing is bought. The engine must not read a trip as slow
// consumption, must pause the stock projection, and must treat perishables left
// behind for longer than their shelf life as gone.
import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  analyze,
  awayDaysBetween,
  categoryDefaults,
  type AwayPeriod,
  type ItemInput,
  type Purchase,
} from './index';

const day = (iso: string) => new Date(`${iso}T08:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_PER_DAY);

function every(start: string, count: number, stepDays: number, qty: number): Purchase[] {
  return Array.from({ length: count }, (_, i) => ({ at: addDays(day(start), i * stepDays), qty }));
}

// Non-perishable staple: 5 kg bags of atta / rice.
const staple = (purchases: Purchase[]): ItemInput => ({ itemId: 'rice', unit: 'g', purchases, perishable: false });
// Perishable: 1 L of milk, 3-day shelf life.
const milk = (purchases: Purchase[], shelfLifeDays: number | null = 3): ItemInput => ({
  itemId: 'milk',
  unit: 'ml',
  purchases,
  perishable: true,
  shelfLifeDays,
});

describe('rate — intervals that overlap an away period', () => {
  it('shortens a non-perishable interval by the away days inside it', () => {
    // 5 kg bought Jan 1 and Jan 31; away Jan 11 → Jan 21. 20 days at home.
    const away: AwayPeriod[] = [{ from: day('2025-01-11'), to: day('2025-01-21') }];
    const p = analyze(staple(every('2025-01-01', 2, 30, 5000)), day('2025-01-31'), { away });
    expect(p.dailyRate).toBeCloseTo(250, 6); // 5000 g / 20 days, not / 30
    expect(p.avgIntervalDays).toBeCloseTo(20, 6);
    expect(p.shortenedForAway).toBe(1);
    expect(p.droppedForAway).toBe(0);
  });

  it('drops a perishable interval that spans a trip — spoiled milk was not drunk', () => {
    // 1 L every 2 days Sep 1 → Sep 9, away Sep 10 → Sep 18, back to every 2 days.
    const purchases = [...every('2025-09-01', 5, 2, 1000), ...every('2025-09-18', 2, 2, 1000)];
    const away: AwayPeriod[] = [{ from: day('2025-09-10'), to: day('2025-09-18') }];
    const now = day('2025-09-20');

    const naive = analyze(milk(purchases), now);
    expect(naive.dailyRate!).toBeLessThan(490); // the 9-day interval drags it down

    const p = analyze(milk(purchases), now, { away });
    expect(p.dailyRate).toBeCloseTo(500, 6);
    expect(p.signalCount).toBe(5);
    expect(p.droppedForAway).toBe(1);
    expect(p.shortenedForAway).toBe(0);
  });

  it('drops an interval that exactly brackets a trip (no days at home left)', () => {
    // Bought Oct 1, away Oct 1 → Oct 11, bought Oct 11, bought Oct 21.
    const away: AwayPeriod[] = [{ from: day('2025-10-01'), to: day('2025-10-11') }];
    const p = analyze(staple(every('2025-10-01', 3, 10, 5000)), day('2025-10-21'), { away });
    expect(p.droppedForAway).toBe(1);
    expect(p.signalCount).toBe(1);
    expect(p.dailyRate).toBeCloseTo(500, 6);
  });

  it('merges overlapping away periods instead of subtracting the overlap twice', () => {
    // Away Jan 11 → 21 and Jan 16 → 26: union is 15 days, so 15 days at home.
    const away: AwayPeriod[] = [
      { from: day('2025-01-11'), to: day('2025-01-21') },
      { from: day('2025-01-16'), to: day('2025-01-26') },
    ];
    const p = analyze(staple(every('2025-01-01', 2, 30, 5000)), day('2025-01-31'), { away });
    expect(p.dailyRate).toBeCloseTo(5000 / 15, 6);
  });

  it('ignores an away period shorter than a day', () => {
    const away: AwayPeriod[] = [{ from: day('2025-01-11'), to: addDays(day('2025-01-11'), 0.5) }];
    const p = analyze(staple(every('2025-01-01', 2, 30, 5000)), day('2025-01-31'), { away });
    expect(p.shortenedForAway).toBe(0);
    expect(p.dailyRate).toBeCloseTo(5000 / 30, 6);
  });

  it('counts an interval in a coverage gap as a gap drop, not an away adjustment', () => {
    const away: AwayPeriod[] = [{ from: day('2025-01-11'), to: day('2025-01-21') }];
    const gaps = [{ from: null, to: day('2025-02-01'), reason: 'coverage' as const }];
    const p = analyze(staple(every('2025-01-01', 2, 30, 5000)), day('2025-01-31'), { away, gaps });
    expect(p.droppedForGaps).toBe(1);
    expect(p.shortenedForAway).toBe(0);
    expect(p.dailyRate).toBeNull();
  });
});

describe('stock projection — paused while away', () => {
  // 5 kg every 10 days → 500 g/day; last bought Oct 1.
  const rice = staple(every('2025-09-01', 4, 10, 5000));
  const away: AwayPeriod[] = [{ from: day('2025-10-03'), to: day('2025-10-20') }];

  it('does not draw stock down on away days', () => {
    const atStart = analyze(rice, day('2025-10-03'), { away });
    const midTrip = analyze(rice, day('2025-10-15'), { away });
    expect(atStart.qtyRemaining).toBeCloseTo(4000, 6); // 2 home days used
    expect(midTrip.qtyRemaining).toBeCloseTo(4000, 6); // nothing used while away
    expect(midTrip.status).toBe(atStart.status);
  });

  it('resumes drawing down after the household is back', () => {
    const p = analyze(rice, day('2025-10-22'), { away });
    expect(p.qtyRemaining).toBeCloseTo(3000, 6); // 2 days before + 2 days after
  });

  it('does not mark the item stale because of a long trip', () => {
    // A 39-day trip: wall-clock since last buy exceeds 3 lifetimes (30 days),
    // but only 2 of those days were at home.
    const longTrip: AwayPeriod[] = [{ from: day('2025-10-02'), to: day('2025-11-10') }];
    const beforeTrip = analyze(rice, day('2025-10-02'));
    const afterTrip = analyze(rice, day('2025-11-11'), { away: longTrip });
    expect(afterTrip.confidence).toBe(beforeTrip.confidence);
  });

  it('treats an ongoing away (to: null) as lasting until now', () => {
    const now = day('2025-10-15');
    const ongoing = analyze(rice, now, { away: [{ from: day('2025-10-03'), to: null }] });
    const explicit = analyze(rice, now, { away: [{ from: day('2025-10-03'), to: now }] });
    expect(ongoing).toEqual(explicit);
  });
});

describe('perishables left behind', () => {
  // 1 L every 2 days → 500 ml/day. The last buy (Oct 1) is a 4 L stock-up, so
  // with only 1 day at home before leaving, 3.5 L would remain if it didn't spoil.
  const purchases = [...every('2025-09-23', 4, 2, 1000), { at: day('2025-10-01'), qty: 4000 }];

  it('are gone after an away at least as long as their shelf life', () => {
    const away: AwayPeriod[] = [{ from: day('2025-10-02'), to: day('2025-10-07') }]; // 5 days ≥ 3
    const p = analyze(milk(purchases), day('2025-10-07'), { away });
    expect(p.qtyRemaining).toBe(0);
    expect(p.status).toBe('LIKELY_OUT');
  });

  it('are only paused after an away shorter than their shelf life', () => {
    const away: AwayPeriod[] = [{ from: day('2025-10-02'), to: day('2025-10-04') }]; // 2 days < 3
    const p = analyze(milk(purchases), day('2025-10-04'), { away });
    expect(p.qtyRemaining).toBeCloseTo(3500, 6); // 1 home day used
  });

  it('are only paused when the shelf life is unknown — never a guessed spoilage', () => {
    const away: AwayPeriod[] = [{ from: day('2025-10-02'), to: day('2025-10-07') }];
    const p = analyze(milk(purchases, null), day('2025-10-07'), { away });
    expect(p.qtyRemaining).toBeCloseTo(3500, 6);
  });
});

describe('without away periods', () => {
  it('produces identical output to before (regression)', () => {
    const rice = staple(every('2025-09-01', 4, 10, 5000));
    const now = day('2025-10-05');
    const a = analyze(rice, now);
    const b = analyze(rice, now, { away: [] });
    expect(b).toEqual(a);
    expect(a.shortenedForAway).toBe(0);
    expect(a.droppedForAway).toBe(0);
  });
});

describe('awayDaysBetween', () => {
  it('sums the days of [start, end] covered by away periods, merged', () => {
    const away: AwayPeriod[] = [
      { from: day('2025-01-05'), to: day('2025-01-10') }, // 5
      { from: day('2025-01-08'), to: day('2025-01-12') }, // overlaps → union 5–12 = 7
      { from: day('2025-01-20'), to: day('2025-01-25') }, // partly outside: 20–22 = 2
    ];
    expect(awayDaysBetween(day('2025-01-01'), day('2025-01-22'), away, day('2025-02-01'))).toBeCloseTo(9, 6);
  });
});

describe('categoryDefaults', () => {
  it('marks fresh categories perishable with conservative shelf lives', () => {
    expect(categoryDefaults('dairy')).toEqual({ perishable: true, shelfLifeDays: 3 });
    expect(categoryDefaults('meat')).toEqual({ perishable: true, shelfLifeDays: 3 });
    expect(categoryDefaults('bakery')).toEqual({ perishable: true, shelfLifeDays: 5 });
    expect(categoryDefaults('produce')).toEqual({ perishable: true, shelfLifeDays: 5 });
  });

  it('treats everything else as non-perishable', () => {
    expect(categoryDefaults('staple')).toEqual({ perishable: false, shelfLifeDays: null });
    expect(categoryDefaults('household')).toEqual({ perishable: false, shelfLifeDays: null });
    expect(categoryDefaults('something-new')).toEqual({ perishable: false, shelfLifeDays: null });
  });
});
