// The import ETA (design §7.10). Never a canned number. Almost all of an
// import's time is pack lookups — one per product no household has resolved
// yet, each followed by the IMPORT_CALL_DELAY_MS pause (measured 2026-09-19:
// 454 lookups took 15.7 min, 347 took 20.0 min; reading the order list took
// under a minute). So:
//
//   time left = lookups left × (measured lookup time + the pause)
//
//  - While the order list is still being read, the lookups known so far are
//    those among the orders read so far: a lower bound that grows as more
//    orders arrive (`stillCounting`). Nothing read yet → no estimate.
//  - After that, the full count is known and the estimate is the real one.
// The lookup time is the moving average of this import's recent lookups;
// before it has any, the last measured import's; before any import, a default.
// Pack lookups run most-bought first, so "ready to use" (the top items done)
// comes well before "complete". `now` is passed in — no clock read here.
import { IMPORT_CALL_DELAY_MS, IMPORT_DEFAULT_LOOKUP_MS, IMPORT_ETA_WINDOW, IMPORT_READY_SKUS } from '../../constants.js';

export function movingAverage(samples: number[], window: number = IMPORT_ETA_WINDOW): number | null {
  const recent = samples.slice(-window);
  if (recent.length === 0) return null;
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

export interface ImportCounts {
  skusTotal: number | null; // null until the order list is fully read
  skusDone: number;
  stepMs: number[]; // durations of this import's recent pack lookups (the call only)
  // While the list is still being read: lookups needed for the orders read so
  // far (null = not counted, or nothing read yet).
  skusSoFar?: number | null;
  // The average lookup time of the last import that measured any.
  measuredLookupMs?: number | null;
  // The pause after each lookup. Zero for a vendor whose packs were learned
  // while listing (VENDOR_PACK_LOOKUP_CALLS): no call, no pause, so counting
  // one would promise minutes of work that is not there.
  pauseMs?: number;
}

export interface ImportEstimate {
  readyAt: Date | null;
  completeAt: Date | null;
  // true: the order list is still being read, so this is the least it takes.
  stillCounting: boolean;
}

export function estimateImport(c: ImportCounts, now: Date): ImportEstimate {
  const lookup = movingAverage(c.stepMs) ?? c.measuredLookupMs ?? IMPORT_DEFAULT_LOOKUP_MS;
  const perStep = lookup + (c.pauseMs ?? IMPORT_CALL_DELAY_MS);
  const after = (steps: number) => new Date(now.getTime() + Math.max(0, steps) * perStep);
  const total = c.skusTotal ?? c.skusSoFar ?? null;
  if (total === null) return { readyAt: null, completeAt: null, stillCounting: true };
  const readyTarget = Math.min(total, IMPORT_READY_SKUS);
  return {
    readyAt: after(readyTarget - c.skusDone),
    completeAt: after(total - c.skusDone),
    stillCounting: c.skusTotal === null,
  };
}
