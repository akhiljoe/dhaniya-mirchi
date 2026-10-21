// The same thing on both apps (insights.ts `comparePrices`).
//
// This is the one comparison nobody else can make for a household, because
// only it holds both histories. That also makes it the easiest place to say
// something confidently wrong, so most of these tests are about what it
// refuses to compare.
import { describe, expect, it } from 'vitest';

import { comparePrices } from './insights';
import type { ApiOrder } from './household';
import { INSIGHTS_COMPARE_MIN_BUYS, INSIGHTS_COMPARE_MIN_GAP } from './constants';

const order = (vendor: string, items: { name: string; pack: string | null; price: number; count?: number }[]): ApiOrder => ({
  vendor,
  orderId: `${vendor}-${Math.random()}`,
  placedAt: '2026-09-01T06:30:00Z',
  total: items.reduce((n, i) => n + i.price, 0),
  addressLabel: null,
  items: items.map((i) => ({ name: i.name, count: i.count ?? 1, pricePaid: i.price, packLabel: i.pack })),
});

// `n` orders of one thing, on one app, at one price.
const bought = (vendor: string, n: number, name: string, pack: string | null, price: number): ApiOrder[] =>
  Array.from({ length: n }, () => order(vendor, [{ name, pack, price }]));

describe('comparePrices', () => {
  it('finds the same product, in the same pack, cheaper on one app', () => {
    const orders = [...bought('instamart', 3, 'Ooty Carrot', '250 g', 29), ...bought('blinkit', 3, 'Ooty Carrot', '250 g', 51)];
    expect(comparePrices(orders)).toEqual([
      { product: 'Ooty Carrot', pack: '250 g', cheaper: 'instamart', dearer: 'blinkit', cheaperPrice: 29, dearerPrice: 51, saving: 22, buys: 6 },
    ]);
  });

  // The bug this was born with. Without a pack label, "Amul Taaza Toned Milk"
  // on one app was matched against the same name on the other and a 500 ml
  // was called dearer than a 1 L: 16 against 75, reported as a saving.
  it('refuses to compare anything without a pack, on either side', () => {
    expect(comparePrices([...bought('instamart', 3, 'Amul Taaza', null, 16), ...bought('blinkit', 3, 'Amul Taaza', null, 75)])).toEqual([]);
    expect(comparePrices([...bought('instamart', 3, 'Amul Taaza', '500 ml', 16), ...bought('blinkit', 3, 'Amul Taaza', null, 75)])).toEqual([]);
  });

  it('never compares two different packs of the same product', () => {
    expect(comparePrices([...bought('instamart', 3, 'Amul Taaza', '500 ml', 30), ...bought('blinkit', 3, 'Amul Taaza', '1 L', 55)])).toEqual([]);
  });

  // One purchase on each side is the week's offer, not a price.
  it('waits for more than one buy on each side', () => {
    const thin = [...bought('instamart', INSIGHTS_COMPARE_MIN_BUYS - 1, 'X', '1 kg', 10), ...bought('blinkit', 4, 'X', '1 kg', 40)];
    expect(comparePrices(thin)).toEqual([]);
  });

  it('ignores a gap too small to act on', () => {
    const small = Math.ceil(100 * INSIGHTS_COMPARE_MIN_GAP) - 1;
    expect(comparePrices([...bought('instamart', 3, 'X', '1 kg', 100), ...bought('blinkit', 3, 'X', '1 kg', 100 + small)])).toEqual([]);
  });

  // Two of a thing is not a dearer thing.
  it('compares what one of it costs, not what the line came to', () => {
    const orders = [
      ...bought('instamart', 3, 'X', '1 kg', 100),
      order('blinkit', [{ name: 'X', pack: '1 kg', price: 300, count: 3 }]),
      order('blinkit', [{ name: 'X', pack: '1 kg', price: 300, count: 3 }]),
    ];
    // Both are 100 each, so there is nothing to report.
    expect(comparePrices(orders)).toEqual([]);
  });

  it('puts the difference that is worth the most first', () => {
    const orders = [
      // A big gap, bought rarely.
      ...bought('instamart', 2, 'Rare', '1 kg', 100),
      ...bought('blinkit', 2, 'Rare', '1 kg', 160),
      // A smaller gap, bought constantly.
      ...bought('instamart', 20, 'Often', '1 kg', 100),
      ...bought('blinkit', 20, 'Often', '1 kg', 130),
    ];
    expect(comparePrices(orders).map((c) => c.product)).toEqual(['Often', 'Rare']);
  });

  it('says nothing when a thing was only ever bought on one app', () => {
    expect(comparePrices(bought('instamart', 5, 'X', '1 kg', 100))).toEqual([]);
  });

  it('ignores a line with no price', () => {
    const noPrice: ApiOrder = {
      ...order('blinkit', [{ name: 'X', pack: '1 kg', price: 0 }]),
      items: [{ name: 'X', count: 1, pricePaid: null, packLabel: '1 kg' }],
    };
    expect(comparePrices([...bought('instamart', 3, 'X', '1 kg', 100), noPrice, noPrice, noPrice])).toEqual([]);
  });
});
