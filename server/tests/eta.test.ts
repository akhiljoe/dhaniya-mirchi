// The import ETA (design §7.10): lookups left × measured time per lookup (the
// pause after each included), never a canned number, with a separate earlier
// milestone for "ready to use".
import { describe, expect, it } from 'vitest';

import { IMPORT_CALL_DELAY_MS, IMPORT_DEFAULT_LOOKUP_MS, IMPORT_ETA_WINDOW, IMPORT_READY_SKUS } from '../src/constants.js';
import { estimateImport, movingAverage } from '../src/worker/import/eta.js';

const NOW = new Date('2026-09-18T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
// Per lookup: the call, then the pause before the next.
const step = (lookupMs: number) => lookupMs + IMPORT_CALL_DELAY_MS;

describe('movingAverage', () => {
  it('averages only the most recent samples', () => {
    const old = Array(50).fill(100_000); // slow start, long ago
    const recent = Array(IMPORT_ETA_WINDOW).fill(2_000);
    expect(movingAverage([...old, ...recent])).toBe(2_000);
  });

  it('is null with no samples', () => {
    expect(movingAverage([])).toBeNull();
  });
});

describe('estimateImport', () => {
  it('has no estimate before any order is read, rather than a made-up one', () => {
    const e = estimateImport({ skusTotal: null, skusDone: 0, stepMs: [], skusSoFar: null }, NOW);
    expect(e).toEqual({ readyAt: null, completeAt: null, stillCounting: true });
  });

  it('while orders are still being read, gives the least it takes from the lookups found so far', () => {
    const e = estimateImport({ skusTotal: null, skusDone: 0, stepMs: [], skusSoFar: 200, measuredLookupMs: 800 }, NOW);
    expect(e.completeAt).toEqual(at(200 * step(800)));
    expect(e.stillCounting).toBe(true);
  });

  it('counts the pause after each lookup: 454 lookups at 0.78 s took 15.7 min, not 6', () => {
    const e = estimateImport({ skusTotal: 454, skusDone: 0, stepMs: Array(10).fill(776) }, NOW);
    const minutes = (e.completeAt!.getTime() - NOW.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(14.5);
    expect(minutes).toBeLessThan(15.5);
    expect(e.stillCounting).toBe(false);
  });

  it("uses this import's measured lookups first, then the last import's, then the default", () => {
    expect(estimateImport({ skusTotal: 300, skusDone: 100, stepMs: Array(10).fill(3_000), measuredLookupMs: 500 }, NOW).completeAt).toEqual(
      at(200 * step(3_000)),
    );
    expect(estimateImport({ skusTotal: 10, skusDone: 0, stepMs: [], measuredLookupMs: 500 }, NOW).completeAt).toEqual(at(10 * step(500)));
    expect(estimateImport({ skusTotal: 10, skusDone: 0, stepMs: [] }, NOW).completeAt).toEqual(at(10 * step(IMPORT_DEFAULT_LOOKUP_MS)));
  });

  it('a sync with nothing new to look up is done now', () => {
    expect(estimateImport({ skusTotal: 0, skusDone: 0, stepMs: [] }, NOW)).toEqual({ readyAt: NOW, completeAt: NOW, stillCounting: false });
  });

  it('predicts "ready to use" once the most-bought items are done — earlier than complete', () => {
    const e = estimateImport({ skusTotal: 600, skusDone: 40, stepMs: [5_000] }, NOW);
    expect(e.readyAt).toEqual(at((IMPORT_READY_SKUS - 40) * step(5_000)));
    expect(e.readyAt!.getTime()).toBeLessThan(e.completeAt!.getTime());
  });

  it('ready is now once past the threshold, and when there are fewer items than it', () => {
    expect(estimateImport({ skusTotal: 600, skusDone: IMPORT_READY_SKUS + 5, stepMs: [5_000] }, NOW).readyAt).toEqual(NOW);
    const small = estimateImport({ skusTotal: 30, skusDone: 10, stepMs: [5_000] }, NOW);
    expect(small.readyAt).toEqual(small.completeAt);
  });

  it('is now when everything is done', () => {
    const e = estimateImport({ skusTotal: 50, skusDone: 50, stepMs: [5_000] }, NOW);
    expect(e.completeAt).toEqual(NOW);
    expect(e.readyAt).toEqual(NOW);
  });
});

describe('a vendor whose packs cost no call', () => {
  // Blinkit's pack is written on the order line and learned while listing, so
  // its lookups touch nothing. Counting the polite pause for them promised
  // about 20 minutes of work that was not there (seen live 2026-09-20).
  it('leaves the pause out of the estimate', () => {
    const now = new Date('2026-09-20T10:00:00Z');
    const counts = { skusTotal: 1000, skusDone: 0, stepMs: [1, 1, 1] };
    const withPause = estimateImport(counts, now);
    const noPause = estimateImport({ ...counts, pauseMs: 0 }, now);
    expect(noPause.completeAt!.getTime()).toBeLessThan(withPause.completeAt!.getTime());
    // 1000 lookups of about 1 ms each: seconds, not twenty minutes.
    expect(noPause.completeAt!.getTime() - now.getTime()).toBeLessThan(60_000);
  });
});
