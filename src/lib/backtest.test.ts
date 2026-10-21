// The backtest (design §17): replay the app day by day over real history and
// score its "running low" flags against what was actually bought next.
import { describe, expect, it } from 'vitest';

import { backtest } from './backtest';
import type { ApiOrder } from './household';

const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
const START = new Date('2026-01-01T04:00:00Z');
const at = (d: number) => new Date(START.getTime() + d * DAY).toISOString();

let seq = 0;
const order = (day: number, names: string[]): ApiOrder => ({
  vendor: 'instamart',
  orderId: `O${++seq}`,
  placedAt: at(day),
  total: 100,
  addressLabel: null,
  items: names.map((name) => ({ name, count: 1, pricePaid: 50, packLabel: name === 'Amul Milk' ? '1 L' : '500 g' })),
});

describe('backtest', () => {
  it('scores a steady item as flagged before every buy, and every flag followed by a buy', () => {
    // 1 L of milk every 4 days for 120 days.
    const orders = Array.from({ length: 31 }, (_, i) => order(i * 4, ['Amul Milk']));
    const r = backtest(orders, [], TZ, new Date(at(40)), new Date(at(110)), { stepDays: 1, horizonDays: 4 });
    expect(r.precision).toBe(1);
    expect(r.precisionAt3).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.flags).toBeGreaterThan(0);
  });

  it('counts a flag with no purchase after it as a miss', () => {
    // Milk steadily, then never again after day 60.
    const orders = Array.from({ length: 16 }, (_, i) => order(i * 4, ['Amul Milk']));
    const r = backtest(orders, [], TZ, new Date(at(40)), new Date(at(90)), { stepDays: 1, horizonDays: 4 });
    expect(r.precision).not.toBeNull();
    expect(r.precision!).toBeLessThan(1);
    expect(r.byItem.find((i) => i.item === 'milk')!.misses).toBeGreaterThan(0);
  });

  it('only scores purchases of items it could have known about', () => {
    // A first-ever purchase can't have been predicted; it is not a missed catch.
    const orders = [order(0, ['Amul Milk']), order(50, ['Basmati Rice'])];
    const r = backtest(orders, [], TZ, new Date(at(10)), new Date(at(60)), { stepDays: 1, horizonDays: 4 });
    expect(r.purchases).toBe(0);
    expect(r.recall).toBeNull();
  });
});
