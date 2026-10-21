// Why the confidence is what it is (estimate.ts, types.ts ConfidenceReason).
//
// The page used to say "Not enough purchase history yet" beside every low
// confidence, and said it about milk bought 135 times. The real reason there
// was that the amount per buy swung too much for one steady rate. These pin
// each reason to the rule that produces it, so the words on the page can be
// the true ones.
import { describe, expect, it } from 'vitest';

import { analyze } from './estimate';
import type { Purchase } from './types';

const DAY = 86_400_000;
const now = new Date('2026-09-22T09:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const buy = (n: number, qty: number | null): Purchase => ({ at: daysAgo(n), qty, prompted: false });
const opts = { gaps: [], sizes: [], away: [] };

describe('why the confidence is low', () => {
  it('says "few" when there are not enough intervals to go on', () => {
    // Two buys: one interval. Low, and honestly so.
    const p = analyze({ itemId: 'x', unit: 'g', purchases: [buy(10, 500), buy(1, 500)] }, now, opts);
    expect(p.confidence).toBe('low');
    expect(p.confidenceReason).toBe('few');
  });

  it('says "uneven" for a thing bought every day in one, two or three packets', () => {
    // Daily milk, varying amounts: plenty of observations, rate all over the
    // place. The rhythm is certain; the amount is not. This is the milk case
    // that was being told "not enough history" after 135 buys.
    const qty = [500, 1500, 500, 2000, 500, 1500, 500, 2500, 500, 1500];
    const purchases = qty.map((q, i) => buy(qty.length - i, q));
    const p = analyze({ itemId: 'milk', unit: 'ml', purchases }, now, opts);
    expect(p.confidence).toBe('low');
    expect(p.confidenceReason).toBe('uneven');
    expect(p.signalCount).toBeGreaterThanOrEqual(4);
  });

  it('says "stale" when the last buy is far older than the model can follow', () => {
    // Steady weekly buys of 700 g, then nothing for 100 days: three lifetimes
    // gone by, the trail is cold.
    const purchases = [buy(135, 700), buy(128, 700), buy(121, 700), buy(114, 700), buy(107, 700), buy(100, 700)];
    const p = analyze({ itemId: 'x', unit: 'g', purchases }, now, opts);
    expect(p.confidenceReason).toBe('stale');
  });

  it('says "stated" when the rate rests on what the household said', () => {
    const p = analyze(
      { itemId: 'eggs', unit: 'piece', purchases: [buy(3, 12)], regular: [{ perDay: 2, from: daysAgo(30), to: null }] },
      now,
      opts,
    );
    expect(p.confidence).toBe('low');
    expect(p.confidenceReason).toBe('stated');
  });

  it('has nothing to explain when the confidence is high', () => {
    const purchases = [buy(35, 700), buy(28, 700), buy(21, 700), buy(14, 700), buy(7, 700), buy(1, 700)];
    const p = analyze({ itemId: 'x', unit: 'g', purchases }, now, opts);
    expect(p.confidence).toBe('high');
    expect(p.confidenceReason).toBeNull();
  });

  it('has nothing to explain with no purchases at all', () => {
    const p = analyze({ itemId: 'x', unit: 'g', purchases: [] }, now, opts);
    expect(p.confidence).toBe('unknown');
    expect(p.confidenceReason).toBeNull();
  });
});
