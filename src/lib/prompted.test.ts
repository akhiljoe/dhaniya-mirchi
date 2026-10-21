// Purchases the app prompted (design §9.1, §9.2): matched narrowly, and kept
// out of the buying rhythm so the app can never confirm its own predictions.
import { describe, expect, it } from 'vitest';

import { buildHousehold, type ApiOrder } from './household';
import { promptedPurchases, type PromptedAdd } from './prompted';

const NOW = new Date('2026-09-20T06:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let n = 0;
const order = (daysAgo: number, names: string[], vendor = 'instamart'): ApiOrder => ({
  vendor,
  orderId: `o${++n}`,
  placedAt: day(daysAgo),
  total: 100,
  addressLabel: null,
  items: names.map((name) => ({ name, count: 1, pricePaid: 24, packLabel: '500 ml' })),
});
const add = (daysAgo: number, item = 'milk', vendor = 'instamart'): PromptedAdd => ({
  item,
  vendor,
  product: 'Nandini Pasteurised Toned Milk',
  quantity: 2,
  addedAt: day(daysAgo),
});

describe('matching an add to the purchase it caused', () => {
  it('marks the first order of that item after the add', () => {
    const before = order(12, ['Nandini Pasteurised Toned Milk']);
    const after = order(9, ['Nandini Pasteurised Toned Milk']);
    const later = order(4, ['Nandini Pasteurised Toned Milk']);
    expect(promptedPurchases([before, after, later], [add(10)])).toEqual(new Set([`${after.orderId}|milk`]));
  });

  it('never marks an order placed before the add', () => {
    expect(promptedPurchases([order(12, ['Nandini Pasteurised Toned Milk'])], [add(10)]).size).toBe(0);
  });

  it('gives up after the matching days, rather than blaming an old suggestion', () => {
    expect(promptedPurchases([order(2, ['Nandini Pasteurised Toned Milk'])], [add(30)]).size).toBe(0);
  });

  it('only matches the same item and the same app', () => {
    const otherItem = order(9, ['Milky Mist Set Curd']);
    const otherApp = order(9, ['Nandini Pasteurised Toned Milk'], 'blinkit');
    expect(promptedPurchases([otherItem, otherApp], [add(10)]).size).toBe(0);
  });

  it('marks one purchase per add, so a household that keeps buying still counts', () => {
    const first = order(9, ['Nandini Pasteurised Toned Milk']);
    const second = order(7, ['Nandini Pasteurised Toned Milk']);
    const third = order(5, ['Nandini Pasteurised Toned Milk']);
    const marked = promptedPurchases([first, second, third], [add(10), add(8)]);
    expect(marked).toEqual(new Set([`${first.orderId}|milk`, `${second.orderId}|milk`]));
  });
});

describe('the rhythm ignores what we prompted', () => {
  // Milk every 6 days by itself. Then the app suggests it three times and
  // they buy each time, a day apart. Those short gaps are evidence the app
  // created: on its own the rhythm would become "every day".
  const own = [30, 24, 18, 12, 6].map((d) => order(d, ['Nandini Pasteurised Toned Milk']));
  const nudged = [5, 4, 3, 2, 1].map((d) => order(d, ['Nandini Pasteurised Toned Milk']));
  const orders = [...own, ...nudged];
  const adds = [add(6), add(5), add(4), add(3), add(2)];
  const milk = (a: PromptedAdd[]) => buildHousehold(orders, [], NOW, 'Asia/Kolkata', undefined, a).inventory.find((i) => i.id === 'milk')!;

  it('keeps the household’s own gap instead of the one we caused', () => {
    expect(milk([]).usualGapDays).toBeLessThan(3); // unmarked: the app's own nudges become the rhythm
    expect(milk(adds).usualGapDays).toBe(6); // marked: the household's own rhythm
  });

  it('still counts a prompted buy as the last purchase', () => {
    expect(milk(adds).lastPurchased).toBe(milk([]).lastPurchased);
  });
});
