// The prediction engine — pure, no I/O (design §9). Given an item's purchase
// history, estimate consumption rate, confidence, remaining stock and status.
// All tunable numbers live in ./constants — never inline them here.
import {
  BURSTY_MIN_CV,
  BURSTY_MIN_OBS,
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW_MIN_OBS,
  CONFIDENCE_MEDIUM,
  CONF_BAND,
  CONF_BUFFER_DAYS,
  DEFAULT_REORDER_LEAD_DAYS,
  HALF_LIFE_DAYS,
  MS_PER_DAY,
  OUTLIER_HIGH_FACTOR,
  OUTLIER_LOW_FACTOR,
  OUTLIER_MIN_OBS,
  RUNNING_LOW_WINDOW_MULTIPLE,
  STALE_LIFETIMES,
  TRUST_UNPROMPTED,
} from './constants';
import { longestSpanDaysBetween, mergeAway, spanDaysBetween, type Span } from './away';
import { overlapsGap } from './coverage';
import { rateScale } from './size';
import type { AnalyzeOptions, Confidence, ConfidenceReason, HistoryGap, ItemInput, Prediction, Purchase, Status } from './types';

const days = (a: Date, b: Date) => (b.getTime() - a.getTime()) / MS_PER_DAY;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stddev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

interface Obs {
  rate: number; // canonical units/day over this interval
  ageDays: number; // age of the closing purchase
  intervalDays: number;
  qtyStart: number; // qty bought at the interval's start
}

// S3: consecutive UNPROMPTED purchases, rate = qty_prev / days at home.
// Invariants (design §9.1, §9.10, §9.11):
//  - Prompted purchases are removed before pairing — they never form or split
//    an interval, so a purchase we suggested can't confirm our own prediction.
//  - An interval that overlaps a HistoryGap is dropped, not averaged in: other
//    purchases may hide inside it, so it would read as slow consumption.
//  - An interval spanning an away period: non-perishable → the away days are
//    subtracted (nothing was used while away); perishable → dropped (what
//    spoiled was discarded, and discarded never feeds the rate). No home days
//    left → dropped.
//  - A purchase with an unknown quantity (pack not learned, §8) closes the
//    interval before it but opens none: skipping it instead would merge two
//    intervals and halve the rate.
//  - Every dropped/shortened interval is counted so the degradation is visible.
function observations(
  purchases: Purchase[],
  now: Date,
  gaps: HistoryGap[],
  away: Span[],
  perishable: boolean,
  scale: (mid: Date) => number,
): { obs: Obs[]; droppedForGaps: number; shortenedForAway: number; droppedForAway: number; droppedForUnknownQty: number } {
  const p = purchases.filter((x) => !x.prompted).sort((a, b) => a.at.getTime() - b.at.getTime());
  const obs: Obs[] = [];
  let droppedForGaps = 0;
  let shortenedForAway = 0;
  let droppedForAway = 0;
  let droppedForUnknownQty = 0;
  for (let i = 1; i < p.length; i++) {
    let interval = days(p[i - 1].at, p[i].at);
    if (interval <= 0) continue; // same-day repeats: skip (can't infer a rate)
    const qtyStart = p[i - 1].qty;
    if (qtyStart === null) {
      droppedForUnknownQty++;
      continue;
    }
    if (gaps.some((g) => overlapsGap(p[i - 1].at, p[i].at, g))) {
      droppedForGaps++;
      continue;
    }
    const awayDays = spanDaysBetween(p[i - 1].at, p[i].at, away);
    if (awayDays > 0) {
      if (perishable || interval - awayDays <= 0) {
        droppedForAway++;
        continue;
      }
      interval -= awayDays;
      shortenedForAway++;
    }
    // Rescaled to today's household (§9.12): 1 L in 4 days for 2 people is
    // 1 L in 2 days for 4.
    const k = scale(new Date((p[i - 1].at.getTime() + p[i].at.getTime()) / 2));
    obs.push({ rate: (qtyStart / interval) * k, ageDays: days(p[i].at, now), intervalDays: interval / k, qtyStart });
  }
  return { obs, droppedForGaps, shortenedForAway, droppedForAway, droppedForUnknownQty };
}

function confidenceOf(n: number, cv: number): Confidence {
  if (n >= CONFIDENCE_HIGH.minObs && cv < CONFIDENCE_HIGH.maxCv) return 'high';
  if (n >= CONFIDENCE_MEDIUM.minObs && cv < CONFIDENCE_MEDIUM.maxCv) return 'medium';
  if (n >= CONFIDENCE_LOW_MIN_OBS) return 'low';
  return 'unknown';
}

// `now` is required: the engine reads no clock (it runs in the browser and the
// worker and must give the same answer for the same inputs).
export function analyze(item: ItemInput, now: Date, opts: AnalyzeOptions = {}): Prediction {
  const purchases = [...item.purchases].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = purchases[purchases.length - 1] ?? null;
  const base: Prediction = {
    itemId: item.itemId,
    unit: item.unit,
    dailyRate: null,
    confidence: 'unknown',
    confidenceReason: null,
    signalCount: 0,
    droppedForGaps: 0,
    shortenedForAway: 0,
    droppedForAway: 0,
    droppedForUnknownQty: 0,
    avgIntervalDays: null,
    qtyRemaining: null,
    daysRemainingLow: null,
    daysRemainingHigh: null,
    status: 'UNKNOWN',
    lastPurchaseAt: last?.at ?? null,
    purchaseCount: purchases.length,
  };

  const away = mergeAway(opts.away ?? [], now);
  const perishable = item.perishable ?? false;
  const sizes = opts.sizes ?? [];
  const scale = (mid: Date) => (item.scalesWith && sizes.length ? rateScale(sizes, mid, now, item.scalesWith) : 1);
  const found = observations(purchases, now, opts.gaps ?? [], away, perishable, scale);
  // A daily amount the household stated (§9.12): the least it uses.
  const statedPerDay = (item.regular ?? [])
    .filter((r) => r.from.getTime() <= now.getTime() && (r.to === null || r.to.getTime() > now.getTime()))
    .reduce((n, r) => n + (r.perDay ?? 0), 0);
  let obs = found.obs;
  base.droppedForGaps = found.droppedForGaps;
  base.shortenedForAway = found.shortenedForAway;
  base.droppedForAway = found.droppedForAway;
  base.droppedForUnknownQty = found.droppedForUnknownQty;
  // No covered interval → no rate. Never borrow or invent one (design §9.3) —
  // but a daily amount the household itself stated is its own evidence.
  if (obs.length === 0 && statedPerDay <= 0) return base;

  // Guard: once we have enough, drop outlier rates (bulk buys, one-offs) — §9.3.
  if (obs.length >= OUTLIER_MIN_OBS) {
    const med = median(obs.map((o) => o.rate));
    obs = obs.filter((o) => o.rate >= OUTLIER_LOW_FACTOR * med && o.rate <= OUTLIER_HIGH_FACTOR * med);
  }
  const rates = obs.map((o) => o.rate);

  // Recency-weighted mean rate (half-life 30d); trust uniform for S3.
  let wSum = 0;
  let wRate = 0;
  for (const o of obs) {
    const w = TRUST_UNPROMPTED * Math.pow(2, -o.ageDays / HALF_LIFE_DAYS);
    wSum += w;
    wRate += w * o.rate;
  }
  // The observed rate, never below what the household said it uses daily.
  const rate = Math.max(wSum > 0 ? wRate / wSum : 0, statedPerDay);

  // Days at home since the last purchase: stock is only used, and the trail
  // only goes stale, while someone is home (§9.11).
  const homeDaysSinceLast = last ? days(last.at, now) - spanDaysBetween(last.at, now, away) : 0;

  // Confidence from count + coefficient of variation (§9.4).
  const cv = rates.length >= 2 && mean(rates) > 0 ? stddev(rates) / mean(rates) : 0;
  // A rate from the household's statement alone is low confidence (§9.12).
  let confidence = obs.length ? confidenceOf(obs.length, cv) : 'low';
  // And why, in the order the rules fire: the last rule to lower it is the
  // one the household is told about, because it is the one that would have
  // to change for the confidence to.
  // "few" only when the COUNT is what stands between this and high: with
  // the count there and the confidence still not, it is the variation.
  // Nine intervals with a swinging rate were being called "few".
  let reason: ConfidenceReason = !obs.length ? 'stated' : confidence === 'high' ? null : obs.length < CONFIDENCE_HIGH.minObs ? 'few' : 'uneven';
  // Demote if the trail is stale: last purchase older than 3 typical lifetimes.
  if (last && last.qty !== null && rate > 0) {
    const lifetime = last.qty / rate;
    if (homeDaysSinceLast > STALE_LIFETIMES * lifetime) {
      confidence = demote(confidence);
      reason = 'stale';
    }
  }
  // Bursty items (ice cream, party buys) cap at low. Also milk bought daily
  // in one, two or three packets: the rhythm is certain, the amount is not.
  if (obs.length >= BURSTY_MIN_OBS && cv > BURSTY_MIN_CV) {
    confidence = 'low';
    reason = 'uneven';
  }

  // Remaining stock: last purchase drawn down at rate over days at home (§9.6,
  // §9.11), assuming prior stock was ~consumed by the last buy (steady use).
  // Perishables left behind for at least their shelf life are gone — computed
  // here, never written as a synthetic discarded event. Unknown shelf life →
  // no spoilage assumed. The latest purchase's quantity unknown → the stock
  // is unknown: said, not guessed.
  let qtyRemaining: number | null = !last ? 0 : last.qty === null ? null : Math.max(0, last.qty - rate * homeDaysSinceLast);
  const shelfLife = item.shelfLifeDays ?? null;
  if (qtyRemaining !== null && last && perishable && shelfLife !== null && longestSpanDaysBetween(last.at, now, away) >= shelfLife) {
    qtyRemaining = 0;
  }

  const daysRemaining = rate > 0 && qtyRemaining !== null ? qtyRemaining / rate : null;
  const band = CONF_BAND[confidence];
  const daysLow = daysRemaining === null ? null : daysRemaining * (1 - band);
  const daysHigh = daysRemaining === null ? null : daysRemaining * (1 + band);

  const status = statusOf({
    confidence,
    rate,
    daysLow,
    qtyRemaining,
    reorderDays: (item.reorderLeadDays ?? DEFAULT_REORDER_LEAD_DAYS) + CONF_BUFFER_DAYS[confidence],
    manualReorderQty: item.manualReorderQty ?? null,
  });

  return {
    ...base,
    dailyRate: rate,
    confidence,
    confidenceReason: reason,
    signalCount: obs.length,
    avgIntervalDays: obs.length ? mean(obs.map((o) => o.intervalDays)) : null,
    qtyRemaining,
    daysRemainingLow: daysLow,
    daysRemainingHigh: daysHigh,
    status,
  };
}

function demote(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : c === 'medium' ? 'low' : c;
}

function statusOf(a: {
  confidence: Confidence;
  rate: number;
  daysLow: number | null;
  qtyRemaining: number | null;
  reorderDays: number;
  manualReorderQty: number | null;
}): Status {
  if (a.qtyRemaining === null) return 'UNKNOWN';
  if (a.manualReorderQty != null) return a.qtyRemaining <= a.manualReorderQty ? 'BUY_SOON' : 'AVAILABLE';
  if (a.confidence === 'unknown' || a.rate <= 0 || a.daysLow === null) return 'UNKNOWN';
  if (a.daysLow <= 0) return 'LIKELY_OUT';
  if (a.daysLow <= a.reorderDays) return 'BUY_SOON';
  if (a.daysLow <= a.reorderDays * RUNNING_LOW_WINDOW_MULTIPLE) return 'RUNNING_LOW';
  return 'AVAILABLE';
}

export function analyzeAll(items: ItemInput[], now: Date, opts: AnalyzeOptions = {}): Prediction[] {
  return items.map((i) => analyze(i, now, opts));
}
