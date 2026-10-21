// Coverage windows (design §9.10): the engine must not read a stretch the
// household's purchase history can't see as a stretch of slow consumption.
//
// Real case this guards: Instamart serves only a rolling 12 months, so before
// its oldest visible order the household's Instamart purchases exist but are
// invisible. An interval spanning that window reads as "milk lasted months".
import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, analyze, coverageGaps, type HistoryGap, type ItemInput, type Purchase } from './index';

const day = (iso: string) => new Date(`${iso}T08:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_PER_DAY);

// `count` purchases of `qty`, one every `stepDays`, starting at `start`.
function every(start: string, count: number, stepDays: number, qty: number): Purchase[] {
  return Array.from({ length: count }, (_, i) => ({ at: addDays(day(start), i * stepDays), qty }));
}

const milk = (purchases: Purchase[]): ItemInput => ({ itemId: 'milk', unit: 'ml', purchases });

// Instamart's history starts here; everything before it is partially invisible.
const COVERAGE_START = day('2025-09-20');
const COVERAGE_GAP: HistoryGap[] = [{ from: null, to: COVERAGE_START, reason: 'coverage' }];
const NOW = day('2025-10-05');

// 1 L of milk every 2 days = 500 ml/day, in three eras:
//  - Jan: Blinkit, fully visible (6 buys)
//  - Mar–mid Sep: only a sparse 1 L every 8 days shows up — the rest were
//    Instamart orders now outside its 12-month window
//  - from the coverage start: every 2 days again, fully visible (8 buys)
const blinkitEra = every('2025-01-01', 6, 2, 1000);
const hiddenEra = every('2025-03-01', 25, 8, 1000); // last one lands 2025-09-16
const visibleEra = every('2025-09-20', 8, 2, 1000);
const history = [...blinkitEra, ...hiddenEra, ...visibleEra];

describe('analyze with coverage gaps', () => {
  it('without gaps, the invisible stretch drags the rate down (the bug being fixed)', () => {
    const p = analyze(milk(history), NOW);
    expect(p.dailyRate).not.toBeNull();
    expect(p.dailyRate!).toBeLessThan(450);
  });

  it('drops every interval that overlaps the gap and estimates only from covered intervals', () => {
    const p = analyze(milk(history), NOW, { gaps: COVERAGE_GAP });
    // 7 intervals of exactly 2 days after the coverage start → exactly 500 ml/day.
    expect(p.dailyRate).toBeCloseTo(500, 6);
    expect(p.signalCount).toBe(7);
    expect(p.avgIntervalDays).toBeCloseTo(2, 6);
    expect(p.confidence).toBe('high');
  });

  it('reports how many observations it dropped, so the degradation is visible', () => {
    const p = analyze(milk(history), NOW, { gaps: COVERAGE_GAP });
    // 5 Jan intervals + Jan→Mar + 24 hidden-era intervals + Sep 16→Sep 20 (straddles the start).
    expect(p.droppedForGaps).toBe(5 + 1 + 24 + 1);
  });

  it('drops an interval that ends exactly at the coverage start (purchases may hide inside it)', () => {
    const p = analyze(
      milk([
        { at: addDays(COVERAGE_START, -10), qty: 1000 },
        { at: COVERAGE_START, qty: 1000 },
        { at: addDays(COVERAGE_START, 2), qty: 1000 },
        { at: addDays(COVERAGE_START, 4), qty: 1000 },
      ]),
      NOW,
      { gaps: COVERAGE_GAP },
    );
    expect(p.droppedForGaps).toBe(1);
    expect(p.signalCount).toBe(2);
    expect(p.dailyRate).toBeCloseTo(500, 6);
  });

  it('never invents a rate when every interval falls in the gap', () => {
    const p = analyze(milk([...blinkitEra, ...hiddenEra]), NOW, { gaps: COVERAGE_GAP });
    expect(p.dailyRate).toBeNull();
    expect(p.confidence).toBe('unknown');
    expect(p.status).toBe('UNKNOWN');
    expect(p.signalCount).toBe(0);
    expect(p.droppedForGaps).toBe(5 + 1 + 24);
    // History is still reported; only the rate is withheld.
    expect(p.purchaseCount).toBe(31);
    expect(p.lastPurchaseAt).toEqual(hiddenEra[hiddenEra.length - 1].at);
  });

  it('handles a bounded gap (e.g. an adapter outage) — intervals either side are kept', () => {
    const outage: HistoryGap[] = [{ from: day('2025-09-26'), to: day('2025-09-30'), reason: 'coverage' }];
    // Buys every 2 days Sep 20 → Oct 4; the outage swallows the Sep 26 & Sep 28 buys' intervals.
    const p = analyze(milk(visibleEra), NOW, { gaps: outage });
    // Intervals: 20→22, 22→24, 24→26 kept; 26→28, 28→30 inside; 30→02, 02→04 kept.
    // 24→26 ends exactly at `from` and 30→02 starts exactly at `to`: neither overlaps.
    expect(p.droppedForGaps).toBe(2);
    expect(p.signalCount).toBe(5);
    expect(p.dailyRate).toBeCloseTo(500, 6);
  });

  it('is unchanged by an empty gap list', () => {
    const a = analyze(milk(history), NOW);
    const b = analyze(milk(history), NOW, { gaps: [] });
    expect(b).toEqual(a);
    expect(a.droppedForGaps).toBe(0);
  });

  it('still excludes prompted purchases from the rate inside covered time (design §9.1)', () => {
    // Unprompted every 4 days; a prompted buy in between must not split an
    // interval into two short ones (which would double the apparent rate).
    const unprompted = every('2025-09-20', 4, 4, 1000); // 250 ml/day
    const prompted: Purchase = { at: addDays(COVERAGE_START, 2), qty: 1000, prompted: true };
    const p = analyze(milk([...unprompted, prompted]), NOW, { gaps: COVERAGE_GAP });
    expect(p.signalCount).toBe(3);
    expect(p.dailyRate).toBeCloseTo(250, 6);
  });
});

describe('coverageGaps', () => {
  it('returns no gaps when no source has a limited window', () => {
    expect(coverageGaps([])).toEqual([]);
    expect(coverageGaps([{ source: 'blinkit', coverageStart: null }])).toEqual([]);
  });

  it('makes history complete only from the LATEST source coverage start', () => {
    // Before Instamart's window opens, Instamart orders exist but can't be seen,
    // so the household's history is incomplete even though Blinkit's isn't.
    const gaps = coverageGaps([
      { source: 'blinkit', coverageStart: day('2023-09-19') },
      { source: 'instamart', coverageStart: COVERAGE_START },
    ]);
    expect(gaps).toEqual([{ from: null, to: COVERAGE_START, reason: 'coverage' }]);
  });

  it('ignores sources with full history when others are limited', () => {
    const gaps = coverageGaps([
      { source: 'blinkit', coverageStart: null },
      { source: 'instamart', coverageStart: COVERAGE_START },
    ]);
    expect(gaps).toEqual([{ from: null, to: COVERAGE_START, reason: 'coverage' }]);
  });
});
