// Household facts (design §9.12): who lives here, guests (including future
// stays), pets and regular use, and what each does to the engine.
import { describe, expect, it } from 'vitest';

import { MS_PER_DAY, analyze, due, gapScale, sizeAhead, sizeAt, sizeTimeline, type Purchase } from './index';

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * MS_PER_DAY);
const buys = (days: number[], qty: number | null = 1000): Purchase[] => days.map((d) => ({ at: at(d), qty }));
const every = (step: number, count: number, start = 0) => Array.from({ length: count }, (_, i) => start + i * step);

describe('sizeTimeline', () => {
  it('steps through residents, guests and pets, guests only on top of a known count', () => {
    const t = sizeTimeline({
      people: [
        { from: at(0), count: 2 },
        { from: at(30), count: 4 },
      ],
      pets: [{ from: at(0), count: 2 }],
      guests: [{ from: at(40), to: at(45), count: 3 }],
    });
    expect(sizeAt(t, at(10), 'people')).toBe(2);
    expect(sizeAt(t, at(35), 'people')).toBe(4);
    expect(sizeAt(t, at(42), 'people')).toBe(7);
    expect(sizeAt(t, at(45), 'people')).toBe(4); // the guests' last day is exclusive
    expect(sizeAt(t, at(42), 'pets')).toBe(2);
  });

  it('never invents a head count: before the first fact, or guests alone, the size is unknown', () => {
    const t = sizeTimeline({ people: [{ from: at(10), count: 2 }], pets: [], guests: [{ from: at(0), to: at(5), count: 3 }] });
    expect(sizeAt(t, at(2), 'people')).toBeNull();
    expect(sizeAt(t, at(2), 'pets')).toBeNull();
    expect(gapScale(t, at(2), at(20), 'people')).toBe(1);
  });

  it('looks ahead: guests arriving inside the window count now', () => {
    const t = sizeTimeline({ people: [{ from: at(0), count: 2 }], pets: [], guests: [{ from: at(12), to: at(19), count: 2 }] });
    expect(sizeAhead(t, at(10), 1, 'people')).toBe(2);
    expect(sizeAhead(t, at(10), 4, 'people')).toBe(4);
  });
});

describe('due — household size', () => {
  const two = sizeTimeline({ people: [{ from: at(-100), count: 2 }], pets: [], guests: [] });
  const fourFrom = (d: number) =>
    sizeTimeline({ people: [{ from: at(-100), count: 2 }, { from: at(d), count: 4 }], pets: [], guests: [] });

  it('rescales gaps learned with fewer people: every 8 days for 2 is every 4 for 4', () => {
    const p = buys(every(8, 8)); // … day 56
    expect(due(p, at(58), { sizes: two }, undefined, { scalesWith: 'people' }).usualGapDays).toBeCloseTo(8, 6);
    const e = due(p, at(58), { sizes: fourFrom(57) }, undefined, { scalesWith: 'people' });
    expect(e.usualGapDays).toBeCloseTo(4, 6);
    expect(e.status).toBe('BUY_SOON');
  });

  it('flags items ahead of guests arriving within the window', () => {
    const p = buys(every(10, 8)); // … day 70; next due day 80
    const guests = sizeTimeline({ people: [{ from: at(-100), count: 2 }], pets: [], guests: [{ from: at(72), to: at(80), count: 2 }] });
    // Twice the people halves the gap, so the item comes due around day 75
    // instead of day 80. On day 71 the guests move it from nothing to coming
    // up; on day 74 to due, while without them it is still only coming up.
    expect(due(p, at(71), { sizes: two }, undefined, { scalesWith: 'people' }).status).toBe('AVAILABLE');
    expect(due(p, at(71), { sizes: guests }, undefined, { scalesWith: 'people' }).status).toBe('RUNNING_LOW');
    expect(due(p, at(74), { sizes: two }, undefined, { scalesWith: 'people' }).status).toBe('RUNNING_LOW');
    expect(due(p, at(74), { sizes: guests }, undefined, { scalesWith: 'people' }).status).toBe('BUY_SOON');
  });

  it('leaves items that scale with nothing, or with pets, alone when people change', () => {
    const p = buys(every(8, 8));
    expect(due(p, at(58), { sizes: fourFrom(57) }).usualGapDays).toBeCloseTo(8, 6);
    expect(due(p, at(58), { sizes: fourFrom(57) }, undefined, { scalesWith: 'pets' }).usualGapDays).toBeCloseTo(8, 6);
  });
});

describe('due — regular use', () => {
  const eggs = (perDay: number | null) => [{ from: at(-100), to: null, perDay }];

  it('a stated daily amount sets a floor: 20 eggs at 2 a day are gone in 10 days', () => {
    const p = buys(every(20, 6), 20); // bought every 20 days, 20 eggs; last day 100
    expect(due(p, at(103)).status).toBe('AVAILABLE');
    const e = due(p, at(107), {}, undefined, { regular: eggs(2) }); // 7 days on: 3 days of eggs left, inside the horizon
    expect(e.status).toBe('BUY_SOON');
    expect(e.daysToNext).toBeCloseTo(3, 6);
  });

  it('decides with no rhythm yet, from the stated amount alone', () => {
    const e = due(buys([0], 10), at(4), {}, undefined, { regular: eggs(2) }); // 10 eggs, 2 a day: 1 day left
    expect(e).toMatchObject({ status: 'BUY_SOON', likelihood: null });
  });

  it('sets no floor without the last quantity — never a guessed one', () => {
    const e = due(buys(every(20, 6), null), at(107), {}, undefined, { regular: eggs(2) });
    expect(e.status).toBe('AVAILABLE');
  });

  it('an item used every day is late, never stopped', () => {
    const p = buys(every(7, 6)); // last day 35
    expect(due(p, at(60)).status).toBe('STOPPED');
    expect(due(p, at(60), {}, undefined, { regular: eggs(null) }).status).toBe('BUY_SOON');
  });

  it('only counts regular use while it lasts', () => {
    const ended = [{ from: at(-100), to: at(50), perDay: null }];
    expect(due(buys(every(7, 6)), at(60), {}, undefined, { regular: ended }).status).toBe('STOPPED');
  });
});

describe('analyze — household facts', () => {
  it('rescales the rate to today’s household', () => {
    const sizes = sizeTimeline({ people: [{ from: at(-100), count: 2 }, { from: at(57), count: 4 }], pets: [], guests: [] });
    const p = analyze({ itemId: 'milk', unit: 'ml', purchases: buys(every(4, 15)), scalesWith: 'people' }, at(57), { sizes });
    expect(p.dailyRate).toBeCloseTo(500, 6); // 1 L every 4 days was for 2 people
  });

  it('never estimates below a stated daily amount, and uses it when there is nothing else', () => {
    const slow = analyze({ itemId: 'eggs', unit: 'piece', purchases: buys(every(30, 4), 30), regular: [{ from: at(-100), to: null, perDay: 2 }] }, at(91));
    expect(slow.dailyRate).toBeCloseTo(2, 6);
    const once = analyze({ itemId: 'eggs', unit: 'piece', purchases: buys([0], 10), regular: [{ from: at(-100), to: null, perDay: 2 }] }, at(1));
    expect(once).toMatchObject({ dailyRate: 2, confidence: 'low', qtyRemaining: 8 });
  });

  it('still has no rate without data or a stated amount', () => {
    expect(analyze({ itemId: 'eggs', unit: 'piece', purchases: buys([0], 10), regular: [{ from: at(-100), to: null, perDay: null }] }, at(1)).dailyRate).toBeNull();
  });
});
