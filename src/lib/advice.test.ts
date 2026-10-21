// What to do, from the orders (advice.ts). Each sentence is pinned to the
// numbers that produce it, and each has a case where it stays quiet.
import { describe, expect, it } from 'vitest';

import { adviceFor } from './advice';
import type { ApiOrder } from './household';

const NOW = new Date('2026-09-22T10:00:00Z');
const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;
let seq = 0;
function order(daysAgo: number, items: { name: string; pack?: string | null; count?: number; price?: number | null }[], hourUtc = 6): ApiOrder {
  const d = new Date(NOW.getTime() - daysAgo * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return {
    vendor: 'instamart',
    orderId: `o${++seq}`,
    placedAt: d.toISOString(),
    total: items.reduce((n, i) => n + (i.price ?? 0), 0),
    addressLabel: 'Home',
    items: items.map((i) => ({ name: i.name, count: i.count ?? 1, pricePaid: i.price ?? null, packLabel: i.pack ?? null })),
  };
}
// The cycle the forecast would name: the 16th to the 15th, today being the 22nd.
const cycle = { from: '2026-09-16', to: '2026-10-15' };
const input = { now: NOW, tz: TZ, cycle, feePerOrder: 12 };

describe('ahead of usual this cycle', () => {
  it('names the item that is far ahead, with the usual figure beside it', () => {
    const orders: ApiOrder[] = [];
    // Three earlier cycles: about ₹300 of chicken in the first week of each.
    for (const monthsBack of [1, 2, 3]) orders.push(order(monthsBack * 30 + 4, [{ name: 'Chicken Breast', pack: '500 g', price: 300 }]));
    // This cycle, a week in: ₹1,500 of chicken.
    orders.push(order(3, [{ name: 'Chicken Breast', pack: '500 g', count: 5, price: 1500 }]));
    const a = adviceFor(orders, input).filter((x) => x.kind === 'ahead');
    expect(a).toHaveLength(1);
    expect(a[0].item).toBe('chicken');
    expect(a[0].title).toMatch(/Chicken is ₹1\.2k ahead of usual this cycle/);
    expect(a[0].amount).toBe(1200);
  });

  it('does not call a bulk buy a trend', () => {
    // Olive oil every two months: nothing in most cycles' first week, ₹4.8k
    // in this one. Ahead of nothing is not ahead.
    const orders = [order(60 + 20, [{ name: 'Borges Olive Oil', pack: '1 L', price: 2400 }]), order(3, [{ name: 'Borges Olive Oil', pack: '1 L', count: 2, price: 4800 }])];
    expect(adviceFor(orders, input).filter((x) => x.kind === 'ahead')).toEqual([]);
  });

  it('says nothing about a small or ordinary difference, or without a cycle', () => {
    const orders = [1, 2, 3].map((m) => order(m * 30 + 4, [{ name: 'Milk', pack: '500 ml', price: 200 }]));
    orders.push(order(3, [{ name: 'Milk', pack: '500 ml', price: 260 }]));
    expect(adviceFor(orders, input).filter((x) => x.kind === 'ahead')).toEqual([]);
    expect(adviceFor(orders, { ...input, cycle: null }).filter((x) => x.kind === 'ahead')).toEqual([]);
  });
});

describe('the second order of the day', () => {
  it('counts a thing that keeps coming as its own order, and names what to add it to', () => {
    const orders: ApiOrder[] = [];
    for (let d = 1; d <= 6; d++) {
      orders.push(order(d, [{ name: 'Milk', pack: '500 ml', price: 24 }, { name: 'Curd', pack: '400 g', price: 40 }, { name: 'Tomato', pack: '500 g', price: 30 }], 4));
      orders.push(order(d, [{ name: 'Bread', pack: '400 g', price: 60 }], 12));
    }
    const a = adviceFor(orders, input).filter((x) => x.kind === 'separate_trips');
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Bread came as its own order 6 times');
    expect(a[0].detail).toMatch(/Add it when you order (milk|curd|tomato)\./);
    expect(a[0].amount).toBe(72); // 6 trips at ₹12
  });

  it('leaves the rupees out when the fee is not known', () => {
    const orders: ApiOrder[] = [];
    for (let d = 1; d <= 5; d++) {
      orders.push(order(d, [{ name: 'Milk', pack: '500 ml', price: 24 }, { name: 'Curd', pack: '400 g', price: 40 }], 4));
      orders.push(order(d, [{ name: 'Bread', pack: '400 g', price: 60 }], 12));
    }
    const a = adviceFor(orders, { ...input, feePerOrder: null }).filter((x) => x.kind === 'separate_trips');
    expect(a[0].amount).toBeNull();
    expect(a[0].detail).not.toMatch(/₹/);
  });

  it('does not count a full second shop as a stray item', () => {
    const orders: ApiOrder[] = [];
    for (let d = 1; d <= 6; d++) {
      orders.push(order(d, [{ name: 'Milk', pack: '500 ml', price: 24 }, { name: 'Curd', pack: '400 g', price: 40 }], 4));
      orders.push(order(d, [{ name: 'Bread', pack: '400 g', price: 60 }, { name: 'Eggs', pack: '6 pieces', price: 70 }, { name: 'Butter', pack: '100 g', price: 60 }], 12));
    }
    expect(adviceFor(orders, input).filter((x) => x.kind === 'separate_trips')).toEqual([]);
  });
});

describe('the bigger pack', () => {
  it('points at the pack that is cheaper per litre, with the monthly saving', () => {
    const orders: ApiOrder[] = [];
    // 500 ml at ₹24 (₹48 a litre) most days; the 1 L at ₹40 twice.
    for (let d = 1; d <= 20; d++) orders.push(order(d, [{ name: 'Nandini Toned Milk', pack: '500 ml', count: 2, price: 48 }]));
    orders.push(order(10, [{ name: 'Nandini Toned Milk', pack: '1 L', price: 40 }]));
    orders.push(order(14, [{ name: 'Nandini Toned Milk', pack: '1 L', price: 40 }]));
    const a = adviceFor(orders, input).filter((x) => x.kind === 'bigger_pack');
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Milk: the 1 L pack is 17% cheaper per litre');
    expect(a[0].detail).toMatch(/500 ml at ₹48 a litre; the 1 L you have bought is ₹40/);
    expect(a[0].amount).toBeGreaterThan(0);
  });

  it('says nothing when the bigger pack is not cheaper, or was bought only once', () => {
    const orders: ApiOrder[] = [];
    for (let d = 1; d <= 10; d++) orders.push(order(d, [{ name: 'Milk', pack: '500 ml', price: 24 }]));
    orders.push(order(5, [{ name: 'Milk', pack: '1 L', price: 50 }]));
    orders.push(order(6, [{ name: 'Milk', pack: '1 L', price: 50 }]));
    expect(adviceFor(orders, input).filter((x) => x.kind === 'bigger_pack')).toEqual([]);
    const once = [...Array.from({ length: 10 }, (_, d) => order(d + 1, [{ name: 'Milk', pack: '500 ml', price: 24 }])), order(5, [{ name: 'Milk', pack: '1 L', price: 30 }])];
    expect(adviceFor(once, input).filter((x) => x.kind === 'bigger_pack')).toEqual([]);
  });
});

describe('prices that moved', () => {
  it('names the product and pack that went up, on the same product', () => {
    const orders: ApiOrder[] = [];
    for (const d of [200, 170, 140, 110]) orders.push(order(d, [{ name: 'Milky Mist Paneer', pack: '200 g', price: 92 }]));
    for (const d of [20, 8]) orders.push(order(d, [{ name: 'Milky Mist Paneer', pack: '200 g', price: 109 }]));
    const a = adviceFor(orders, input).filter((x) => x.kind === 'price_rise');
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('Milky Mist Paneer · 200 g is up 18%');
    expect(a[0].detail).toBe('₹109 a pack lately, ₹92 before that.');
  });

  it('never reads a change of brand as a rise', () => {
    const orders: ApiOrder[] = [];
    for (const d of [200, 170, 140, 110]) orders.push(order(d, [{ name: 'Amul Paneer', pack: '200 g', price: 80 }]));
    for (const d of [20, 8]) orders.push(order(d, [{ name: 'Milky Mist Paneer', pack: '200 g', price: 109 }]));
    expect(adviceFor(orders, input).filter((x) => x.kind === 'price_rise')).toEqual([]);
  });
});

describe('bought once, long ago', () => {
  it('lists them, oldest forgotten things included, with a way to stop tracking each', () => {
    const orders = [
      order(200, [{ name: 'Zeneme 18 K Gold Plated Earrings', pack: '1 Pair', price: 212 }]),
      order(150, [{ name: 'Face Mask', pack: '1 piece', price: 99 }]),
      order(2, [{ name: 'Milk', pack: '500 ml', price: 24 }]), // once, but recent: not forgotten yet
    ];
    const a = adviceFor(orders, input).filter((x) => x.kind === 'bought_once');
    expect(a).toHaveLength(1);
    expect(a[0].title).toBe('2 things were bought once, months ago, and never again');
    expect(a[0].items?.map((i) => i.item)).toEqual(expect.arrayContaining(['face mask']));
    expect(a[0].items?.some((i) => i.item === 'milk')).toBe(false);
  });

  it('says nothing when everything has been bought more than once', () => {
    const orders = [order(200, [{ name: 'Milk', pack: '500 ml', price: 24 }]), order(2, [{ name: 'Milk', pack: '500 ml', price: 24 }])];
    expect(adviceFor(orders, input).filter((x) => x.kind === 'bought_once')).toEqual([]);
  });
});
