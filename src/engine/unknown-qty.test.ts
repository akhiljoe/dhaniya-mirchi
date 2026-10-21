// Purchases whose pack is unknown (design §8): we know the date, not the
// quantity. Such a purchase must still END the interval before it — dropping
// it would merge two intervals into one and silently halve the rate, which
// the engine must never do (CLAUDE.md "The engine degrades, never lies").
import { describe, expect, it } from 'vitest';
import { MS_PER_DAY, analyze, type ItemInput, type Purchase } from './index';

const day = (iso: string) => new Date(`${iso}T08:00:00Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_PER_DAY);

// 1 L every 5 days = 200 ml/day.
function every(start: string, count: number, qty: number | null = 1000): Purchase[] {
  return Array.from({ length: count }, (_, i) => ({ at: addDays(day(start), i * 5), qty }));
}
const milk = (purchases: Purchase[]): ItemInput => ({ itemId: 'milk', unit: 'ml', purchases });

describe('a purchase with an unknown quantity', () => {
  it('ends the interval before it but opens none — the rate is not halved', () => {
    const p = every('2026-08-01', 8);
    p[4] = { ...p[4], qty: null };
    const now = addDays(p[7].at, 1);
    const r = analyze(milk(p), now);
    expect(r.dailyRate).toBeCloseTo(200, 5);
    expect(r.droppedForUnknownQty).toBe(1); // the interval it would have opened
    expect(r.purchaseCount).toBe(8);
  });

  it('with every quantity unknown there is no rate — never an invented one', () => {
    const p = every('2026-08-01', 6, null);
    const r = analyze(milk(p), addDays(p[5].at, 1));
    expect(r.dailyRate).toBeNull();
    expect(r.status).toBe('UNKNOWN');
    expect(r.lastPurchaseAt).toEqual(p[5].at);
    expect(r.purchaseCount).toBe(6);
  });

  it('as the latest purchase, leaves the stock unknown instead of guessing it', () => {
    const p = every('2026-08-01', 6);
    p[5] = { ...p[5], qty: null };
    const r = analyze(milk(p), addDays(p[5].at, 1));
    expect(r.dailyRate).toBeCloseTo(200, 5);
    expect(r.qtyRemaining).toBeNull();
    expect(r.daysRemainingLow).toBeNull();
    expect(r.status).toBe('UNKNOWN');
  });
});
