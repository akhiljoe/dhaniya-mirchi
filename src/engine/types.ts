import type { Unit } from './units';

export type Confidence = 'high' | 'medium' | 'low' | 'unknown';

// Why the confidence is what it is, so a page can say the true reason rather
// than a stock phrase. "Not enough purchase history yet" was said about milk
// bought 135 times: the real reason was that the amount per buy varied too
// much for a steady rate, which is a different fact and points somewhere else.
//   few     - too few usable intervals (§9.4)
//   uneven  - enough of them, but the rate swings too much to trust (bursty)
//   stale   - the last purchase is older than the model can follow
//   stated  - the rate rests on what the household said, not on purchases
export type ConfidenceReason = 'few' | 'uneven' | 'stale' | 'stated' | null;
export type Status = 'AVAILABLE' | 'RUNNING_LOW' | 'BUY_SOON' | 'LIKELY_OUT' | 'UNKNOWN';

// One purchase of a canonical item, quantity already in canonical units.
// `prompted` = we suggested it → excluded from rate estimation (design §9.2).
export interface Purchase {
  at: Date;
  // null = the pack is unknown (design §8): the date is real, the quantity
  // isn't known. It still ends the interval before it; it opens none.
  qty: number | null;
  prompted?: boolean;
}

export interface ItemInput {
  itemId: string; // canonical name
  unit: Unit;
  purchases: Purchase[];
  reorderLeadDays?: number; // default DEFAULT_REORDER_LEAD_DAYS
  manualReorderQty?: number | null;
  // Design §9.11. Resolved by the caller (item override, else categoryDefaults());
  // the engine never infers them. Omitted = non-perishable, shelf life unknown.
  perishable?: boolean;
  shelfLifeDays?: number | null; // null/omitted = unknown → never assumed to spoil
  // Design §9.12: what its use scales with (omitted = never rescaled), and
  // the household's stated regular use of it.
  scalesWith?: 'people' | 'pets';
  regular?: RegularUse[];
}

// A stretch when the whole household was away (design §9.11): nothing was
// consumed and nothing was bought. Half-open [from, to); `to: null` = ongoing,
// treated as lasting until `now`.
export interface AwayPeriod {
  from: Date;
  to: Date | null;
}

// A stretch of time where the household's purchase history is known to be
// incomplete — purchases happened that we cannot see (design §9.10). `from:
// null` means "since the beginning". Half-open: [from, to).
export interface HistoryGap {
  from: Date | null;
  to: Date;
  reason: 'coverage'; // a source's history doesn't reach back this far
}

// How far back one source's order history reaches. `coverageStart: null`
// means the source serves the full history (no window).
export interface SourceCoverage {
  source: string;
  coverageStart: Date | null;
}

// Who lived in the household from `from` on (design §9.12), until the next
// entry. People and pets are counts; a timeline is these, in any order.
export interface HouseholdSize {
  from: Date;
  people: number;
  pets: number;
}

// A standing fact about one item (design §9.12): "the dogs eat 2 boiled eggs
// a day". perDay in the item's canonical unit; null = used every day, amount
// not given. [from, to); to null = still so.
export interface RegularUse {
  from: Date;
  to: Date | null;
  perDay: number | null;
}

export interface AnalyzeOptions {
  gaps?: HistoryGap[];
  away?: AwayPeriod[];
  sizes?: HouseholdSize[];
}

export interface Prediction {
  itemId: string;
  unit: Unit;
  dailyRate: number | null; // canonical units/day
  confidence: Confidence;
  confidenceReason: ConfidenceReason; // null when high, or when there is nothing to explain
  signalCount: number; // observations used (excludes priors)
  droppedForGaps: number; // intervals discarded because they overlap a HistoryGap
  shortenedForAway: number; // non-perishable intervals with away days subtracted
  droppedForAway: number; // intervals discarded: perishable across a trip, or no home days left
  droppedForUnknownQty: number; // intervals opened by a purchase whose quantity is unknown
  avgIntervalDays: number | null;
  qtyRemaining: number | null;
  daysRemainingLow: number | null;
  daysRemainingHigh: number | null;
  status: Status;
  lastPurchaseAt: Date | null;
  purchaseCount: number;
}
