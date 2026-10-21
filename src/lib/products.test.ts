// Which product to add for an item (design §19 Ordering, "which product"):
// the household's own buying decides the default; a saved order replaces it;
// a ruled-out product is never offered.
import { describe, expect, it } from 'vitest';

import { buildHousehold, type ApiOrder } from './household';
import { ProductTally, rankProducts, type Product, matchProducts } from './products';

const NOW = new Date('2026-09-19T06:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function tally(buys: [string, number][]): Product[] {
  const t = new ProductTally(NOW);
  for (const [name, ago] of buys) t.add(name, '500 ml', 'instamart', daysAgo(ago));
  return t.products();
}

describe('the default order', () => {
  it('puts what was bought most lately first, not most ever', () => {
    const p = tally([
      ...Array.from({ length: 30 }, (_, i): [string, number] => ['Akshayakalpa Cow Milk', 100 + i]), // lots, long ago
      ...Array.from({ length: 10 }, (_, i): [string, number] => ['Nandini Toned Milk', i + 1]),
      ['Amul Taaza Toned Milk', 3],
    ]);
    expect(p.map((x) => x.name)).toEqual(['Nandini Toned Milk', 'Amul Taaza Toned Milk', 'Akshayakalpa Cow Milk']);
    expect(p[0]).toMatchObject({ recent: 10, total: 10, pack: '500 ml', vendors: ['instamart'] });
  });

  it('breaks a tie with the one bought last', () => {
    expect(tally([['Amul Gold', 5], ['Nandini Toned Milk', 2]]).map((x) => x.name)).toEqual(['Nandini Toned Milk', 'Amul Gold']);
  });

  it('treats spellings of one product as one', () => {
    const p = tally([['DROOLS MILK BONE JAR', 2], ['Drools Milk Bone Jar', 20]]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ name: 'DROOLS MILK BONE JAR', total: 2 });
  });
});

describe('a saved order', () => {
  const products = tally([['Nandini Toned Milk', 1], ['Nandini Toned Milk', 2], ['Amul Taaza Toned Milk', 3], ['Akshayakalpa Cow Milk', 4], ['Arokya Toned Milk', 5]]);

  it('replaces the default, and never offers what was ruled out', () => {
    const { ranked, blocked } = rankProducts(products, { item: 'milk', ranked: ['Amul Taaza Toned Milk', 'nandini toned milk'], blocked: ['Arokya Toned Milk'] });
    expect(ranked.map((x) => x.name)).toEqual(['Amul Taaza Toned Milk', 'Nandini Toned Milk', 'Akshayakalpa Cow Milk']);
    expect(blocked.map((x) => x.name)).toEqual(['Arokya Toned Milk']);
  });

  it('leaves out products no longer bought, and adds new ones after the saved ones', () => {
    const { ranked } = rankProducts(products, { item: 'milk', ranked: ['Heritage Milk', 'Akshayakalpa Cow Milk'], blocked: [] });
    expect(ranked.map((x) => x.name)).toEqual(['Akshayakalpa Cow Milk', 'Nandini Toned Milk', 'Amul Taaza Toned Milk', 'Arokya Toned Milk']);
  });

  it('is the default with no saved order', () => {
    expect(rankProducts(products, null)).toEqual({ ranked: products, blocked: [] });
  });
});

describe('the Stock page gets each item’s products', () => {
  it('counts a product once per order, grouped under its item', () => {
    const order = (id: string, ago: number, names: string[]): ApiOrder => ({
      vendor: 'instamart',
      orderId: id,
      placedAt: daysAgo(ago).toISOString(),
      total: 100,
      addressLabel: null,
      items: names.map((name) => ({ name, count: 1, pricePaid: 30, packLabel: '500 ml' })),
    });
    const orders = [
      order('a', 1, ['Nandini Pasteurised Toned Milk', 'Nandini Pasteurised Toned Milk']),
      order('b', 5, ['Nandini Pasteurised Toned Milk']),
      order('c', 9, ['Amul Taaza Toned Milk']),
    ];
    const milk = buildHousehold(orders, [], NOW, 'Asia/Kolkata').inventory.find((i) => i.id === 'milk')!;
    expect(milk.products?.map((p) => [p.name, p.total])).toEqual([
      ['Nandini Pasteurised Toned Milk', 2],
      ['Amul Taaza Toned Milk', 1],
    ]);
  });
});

describe('how many are usually bought at once', () => {
  it('is the middle of the counts, so the cart proposes the usual', () => {
    const t = new ProductTally(NOW);
    for (const [ago, count] of [[2, 2], [6, 2], [10, 1], [14, 2], [20, 3]] as [number, number][]) {
      t.add('Nandini Pasteurised Toned Milk', '500 ml', 'instamart', daysAgo(ago), count);
    }
    expect(t.products()[0].usualCount).toBe(2);
  });

  // The household's own data: 1 packet 103 times over the years, 2 packets on
  // most trips lately. The cart should propose 2.
  it('follows what the household buys now, not what it used to', () => {
    const t = new ProductTally(NOW);
    for (let i = 0; i < 103; i++) t.add('Nandini Pasteurised Toned Milk', '500 ml', 'instamart', daysAgo(90 + i), 1);
    for (let i = 0; i < 32; i++) t.add('Nandini Pasteurised Toned Milk', '500 ml', 'instamart', daysAgo(2 + i), 2);
    expect(t.products()[0].usualCount).toBe(2);
  });

  it('is 1 when nothing was counted', () => {
    const t = new ProductTally(NOW);
    t.add('Nandini Pasteurised Toned Milk', '500 ml', 'instamart', daysAgo(1), 0);
    expect(t.products()[0].usualCount).toBe(1);
  });
});

describe('matchProducts', () => {
  // A household's list for one item is usually short, but this one has 30
  // kinds of chocolate and 14 each of chicken, ice cream and soft drink.
  const list = [
    { name: 'Amul Dark Chocolate', pack: '150 g', total: 4, recent: 2 },
    { name: "Cadbury Dairy Milk Silk", pack: '60 g', total: 9, recent: 5 },
    { name: 'Amul Milk Chocolate', pack: '150 g', total: 2, recent: 0 },
  ] as Parameters<typeof matchProducts>[0];

  it('finds by brand and by kind', () => {
    expect(matchProducts(list, 'amul').map((p) => p.name)).toEqual(['Amul Dark Chocolate', 'Amul Milk Chocolate']);
    expect(matchProducts(list, 'dark').map((p) => p.name)).toEqual(['Amul Dark Chocolate']);
  });

  // "500 ml" is often the only thing telling two entries apart.
  it('finds by pack', () => {
    expect(matchProducts(list, '60 g').map((p) => p.name)).toEqual(['Cadbury Dairy Milk Silk']);
  });

  it('ignores case and stray spaces', () => {
    expect(matchProducts(list, '  SILK ')).toHaveLength(1);
  });

  it('gives everything back for an empty search, and nothing for a miss', () => {
    expect(matchProducts(list, '')).toHaveLength(3);
    expect(matchProducts(list, 'ferrero')).toEqual([]);
  });

  it('keeps the order it was given, so the ranking survives a search', () => {
    expect(matchProducts(list, 'chocolate').map((p) => p.name)).toEqual(['Amul Dark Chocolate', 'Amul Milk Chocolate']);
  });
});
