// Every tunable number the engine uses, in one place. Change a value here,
// never inline in the logic. Each group names the design section it implements.
//
// ANY change to a value in this file is a math change: bump ALGORITHM_VERSION
// (design §9.9), which triggers a full rebuild of inventory_state.
import type { Confidence } from './types';

// Bump on ANY change to the math. A new version triggers a full rebuild of
// inventory_state from the event log (design §9.9, §11 rule 2).
//   1 — bootstrap: interval rate, recency weighting, confidence, status.
//   2 — toCanonical refuses cross-dimension conversions; intervals that
//       overlap a coverage gap are dropped (design §9.10).
//   3 — household away: non-perishable intervals shortened by away days,
//       perishable ones dropped; stock decays only on days at home;
//       perishables spoil during an away ≥ shelf life (design §9.11).
//   4 — vendor order lines: pack labels parsed to canonical quantities in
//       the engine (packs.ts); a line with an unknown pack keeps its date
//       but no quantity (design §8) — it closes the interval before it and
//       opens none, and as the latest purchase leaves the stock unknown.
//   5 — the running-low status comes from the household's own buying rhythm
//       (due.ts): a recency-weighted survival estimate over the gaps
//       between shopping trips, not from projected stock (design §9.6).
//   6 — household facts (design §9.12): gaps and rates rescaled to who lives
//       here (and guests ahead), a stated daily use as a floor, and items
//       used every day never read as stopped.
//   8 — a counted pack that states its contents, "1 pack (500 ml)" (Zepto,
//       design Appendix D), is its contents, not one piece; with more than
//       one pack it is unknown, since it cannot say whether each holds 500 ml.
//       A size the store does not fix ("500 g or 534 g", "900 g - 1 kg",
//       "200 - 300 g") is its smaller size, not whichever number came first.
export const ALGORITHM_VERSION = 8;

export const MS_PER_DAY = 86_400_000;

// ---- What is in the house explains the flag (design §9.6, holdback.ts) ------

// Days' worth in the kitchen for the card to say "enough for today". Display
// only: letting the stock lower a flag was measured and was worse (holdback.ts
// carries the numbers), so this changes no status and no version.
export const STOCK_ENOUGH_FOR_TODAY_DAYS = 1;

// ---- Rate estimate (design §9.2, §9.3) ----------------------------------

// Recency weighting: an observation's weight halves every this many days.
export const HALF_LIFE_DAYS = 30;
// Trust weight of an unprompted purchase interval (signal S3). Uniform across
// S3 observations today, so it cancels in the weighted mean.
export const TRUST_UNPROMPTED = 0.5;
// Outlier guard: applied once there are at least this many observations …
export const OUTLIER_MIN_OBS = 3;
// … keeping only rates within [LOW × median, HIGH × median].
export const OUTLIER_LOW_FACTOR = 0.2;
export const OUTLIER_HIGH_FACTOR = 5;

// ---- Confidence (design §9.4) -------------------------------------------

export const CONFIDENCE_HIGH = { minObs: 4, maxCv: 0.3 };
export const CONFIDENCE_MEDIUM = { minObs: 2, maxCv: 0.6 };
export const CONFIDENCE_LOW_MIN_OBS = 1;
// Demote one level when the last purchase is older than this many lifetimes
// (lifetime = qty bought / rate) — the model has lost the thread.
export const STALE_LIFETIMES = 3;
// Bursty items (ice cream, party buys): with at least this many observations
// and a coefficient of variation above this, confidence is capped at low.
export const BURSTY_MIN_OBS = 4;
export const BURSTY_MIN_CV = 0.8;

// ---- Stock, depletion, status (design §9.6) -----------------------------

// Days-remaining range half-width, as a fraction, per confidence.
export const CONF_BAND: Record<Confidence, number> = { high: 0.15, medium: 0.35, low: 0.6, unknown: 0.6 };
// Extra days of warning per confidence — lower confidence warns earlier.
export const CONF_BUFFER_DAYS: Record<Confidence, number> = { high: 1, medium: 2, low: 3, unknown: 3 };
// Default days between deciding to buy and the item arriving.
export const DEFAULT_REORDER_LEAD_DAYS = 1;
// RUNNING_LOW fires within this multiple of the reorder window.
export const RUNNING_LOW_WINDOW_MULTIPLE = 2;

// ---- When the household buys next: the running-low status (design §9.6) --
// Each value was picked on real history with spike/db/experiment.ts (the
// backtest, design §17): about a year of orders, 90 days replayed, 4-day horizon.

// Purchases this close together are one shopping trip (two orders an hour
// apart, or two members' orders on one afternoon). 0 h and 12 h scored the
// same; 12 h keeps a split basket from reading as "bought again already".
export const DUE_TRIP_MERGE_HOURS = 12;
// A gap's weight halves every this many days. 60 beat 120 and no decay
// (precision 44% vs 43% and 38% at the same threshold): habits change.
export const DUE_HALF_LIFE_DAYS = 60;
// Pseudo-weight added to the gaps still open at s: an item with a few old
// gaps is not flagged on the strength of one of them.
export const DUE_PRIOR_WEIGHT = 1;
// Fewer gaps than this → no estimate (status UNKNOWN), never a borrowed one.
export const DUE_MIN_INTERVALS = 2;
// "Running low" = likely bought within this many days.
export const DUE_HORIZON_DAYS = 4;
// Flag when the likelihood reaches this. 0.25: 11.1 flags a day, 43%
// precision, 60% recall; the stock-based status was 23.0, 29%, 67%.
export const DUE_MIN_LIKELIHOOD = 0.25;
// A fast item's own rhythm is its horizon, capped by DUE_HORIZON_DAYS and
// floored at DUE_HORIZON_MIN_DAYS. Flat 4 days asks "will they buy it within
// 4 days?", and for bread bought every 2 days the answer is yes the hour it
// is delivered - so the list said buy bread on the day it arrived, forever.
// Measured on the household's own 90 days: 15% of all flags were for
// something bought in the last 24 hours, 29% in the last 48.
export const DUE_HORIZON_GAP_FRACTION = 0.5;
// Never a horizon under a day: the list is read once a day, so "due within
// half a day" is a flag that appears and vanishes between two looks.
export const DUE_HORIZON_MIN_DAYS = 1;
// Just bought it: for this fraction of its own usual gap, capped at
// DUE_QUIET_MAX_DAYS, an item is never "buy soon". The rhythm alone cannot
// say this, because a household that sometimes rebuys the next day has short
// gaps in its history, and those short gaps pull the quantile the flag is
// read from down to a day or two even the hour the shopping arrives. Those
// short gaps are the times they ran out; today they did not.
export const DUE_QUIET_FRACTION = 0.5;
// The quiet window is never longer than this, however slow the item: a week
// after a delivery the household may genuinely need it again.
export const DUE_QUIET_MAX_DAYS = 1;
// "Coming up" = the same likelihood reached within this multiple of the horizon.
export const DUE_COMING_UP_HORIZON_MULTIPLE = 2;
// Past every gap it has had, but within this many usual gaps: overdue, so
// BUY_SOON. Beyond it: STOPPED (bought elsewhere, or no longer). Without it,
// a steady item a few hours past its longest gap read "not bought in a
// while". 1 → 1.5 cost 2 points of precision (43% → 41%) on the backtest.
export const DUE_OVERDUE_GAPS = 1.5;

// ---- Household away (design §9.11) --------------------------------------

// Away periods shorter than this are noise and ignored.
export const MIN_AWAY_DAYS = 1;
// Per-category defaults for perishability and shelf life, used when the item
// has no override. Conservative: assuming something spoiled only brings the
// restock nudge earlier.
export const CATEGORY_SHELF_LIFE: Record<string, { perishable: boolean; shelfLifeDays: number | null }> = {
  dairy: { perishable: true, shelfLifeDays: 3 },
  meat: { perishable: true, shelfLifeDays: 3 },
  bakery: { perishable: true, shelfLifeDays: 5 },
  produce: { perishable: true, shelfLifeDays: 5 },
};
export const NON_PERISHABLE = { perishable: false, shelfLifeDays: null } as const;

// ---- Units (design §8.2) ------------------------------------------------

// Raw unit token → canonical dimension and multiplier.
export const UNIT_FACTORS: Record<string, { unit: 'ml' | 'g' | 'piece'; f: number }> = {
  ml: { unit: 'ml', f: 1 },
  l: { unit: 'ml', f: 1000 },
  litre: { unit: 'ml', f: 1000 },
  g: { unit: 'g', f: 1 },
  gm: { unit: 'g', f: 1 },
  kg: { unit: 'g', f: 1000 },
  piece: { unit: 'piece', f: 1 },
  pcs: { unit: 'piece', f: 1 },
  nos: { unit: 'piece', f: 1 },
};
// "1 dozen" on a catalog pack label (design §8).
export const PIECES_PER_DOZEN = 12;
// formatQty switches to L / kg at this many ml / g.
export const DISPLAY_LARGE_UNIT_AT = 1000;
