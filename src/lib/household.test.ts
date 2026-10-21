// Orders → the household the pages show (design §9, §12): classified by the
// catalog, quantities and predictions by the engine, worded here. Honesty is
// the point: no invented numbers anywhere.
import { describe, expect, it } from 'vitest';

import { buildHousehold, relativeDay, runsOutIn, runsOutText, timeAgo, type ApiOrder } from './household';

const NOW = new Date('2026-09-19T10:00:00Z');
const TZ = 'Asia/Kolkata';
const daysAgo = (n: number, hourUtc = 4) => {
  const d = new Date(NOW.getTime() - n * 86_400_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

let seq = 0;
function order(placedAt: string, items: ApiOrder['items'], total = 100): ApiOrder {
  return { vendor: 'instamart', orderId: `O${++seq}`, placedAt, total, addressLabel: 'Home', items };
}
const line = (name: string, packLabel: string | null, count = 1, pricePaid: number | null = 30) => ({ name, count, pricePaid, packLabel });

// 1 L of milk (2 × 500 ml) every 2 days for a month; last bought yesterday.
const milkOrders = Array.from({ length: 15 }, (_, i) => order(daysAgo(1 + 2 * i), [line('Amul Taaza Toned Milk', '500 ml', 2, 56)]));

describe('buildHousehold', () => {
  it('turns a regular purchase into a real prediction', () => {
    const h = buildHousehold(milkOrders, [], NOW, TZ);
    const milk = h.inventory.find((i) => i.id === 'milk')!;
    expect(milk).toMatchObject({ name: 'Milk', emoji: '🥛', category: 'Dairy & eggs', purchaseFrequency: 'Every ~2 days', lastPurchased: 'yesterday', typicalQuantity: '1.0 L' });
    expect(milk.estimatedAmount).toMatch(/^About \d+ ml left$/);
    expect(milk.daysUntilLow).not.toBeNull();
    expect(['likely-low', 'coming-up']).toContain(milk.status);
    expect(milk.history[0]).toMatchObject({ source: 'instamart', quantity: '2 × 500 ml', price: 56 });
  });

  it('groups brands into one item and leaves non-groceries out', () => {
    const h = buildHousehold(
      [order(daysAgo(3), [line('Nandini Milk', '1 L'), line('Google Pay Gift Card', null)]), order(daysAgo(1), [line('Amul Gold Full Cream Milk', '500 ml')])],
      [],
      NOW,
      TZ,
    );
    expect(h.inventory.map((i) => i.id)).toEqual(['milk']);
  });

  it('adds up two lines of one item in the same order — one shopping trip, one purchase', () => {
    const h = buildHousehold(
      [
        order(daysAgo(5), [line('Amul Milk', '500 ml'), line('Nandini Milk', '500 ml')]),
        order(daysAgo(3), [line('Amul Milk', '500 ml'), line('Nandini Milk', '500 ml')]),
        order(daysAgo(1), [line('Amul Milk', '500 ml'), line('Nandini Milk', '500 ml')]),
      ],
      [],
      NOW,
      TZ,
    );
    const milk = h.inventory.find((i) => i.id === 'milk')!;
    expect(milk.typicalQuantity).toBe('1.0 L');
    expect(milk.purchaseFrequency).toBe('Every ~2 days');
  });

  it('says a pack is unknown instead of guessing a quantity, but still knows when it is due', () => {
    // Bought every 4 days, pack never learned: the dates are real, the amount isn't.
    const h = buildHousehold(
      [order(daysAgo(15), [line('Coriander Leaves', null)]), order(daysAgo(11), [line('Coriander Leaves', null)]), order(daysAgo(7), [line('Coriander Leaves', null)]), order(daysAgo(3), [line('Coriander Leaves', null)])],
      [],
      NOW,
      TZ,
    );
    const c = h.inventory.find((i) => i.id === 'coriander')!;
    // Due, and the pack never learned: it says what it knows (when) rather
    // than what it does not (how much), because the two side by side read as
    // a contradiction.
    expect(c).toMatchObject({ status: 'likely-low', estimatedAmount: 'Usually bought by now', purchaseFrequency: 'Every ~4 days' });
    expect(c.history[0].quantity).toBe('1 pack');
  });

  it('has no status for an item with too little history to have a rhythm', () => {
    const h = buildHousehold([order(daysAgo(9), [line('Coriander Leaves', null)]), order(daysAgo(5), [line('Coriander Leaves', null)])], [], NOW, TZ);
    expect(h.inventory.find((i) => i.id === 'coriander')).toMatchObject({ status: 'unknown', daysUntilLow: null });
  });

  it('shows a one-off only while it is recent — old one-offs are not inventory', () => {
    const h = buildHousehold(
      [order(daysAgo(200), [line('Himalayan Pink Rock Crystals', '500 g')]), order(daysAgo(10), [line('Saffron Strands', '1 g')])],
      [],
      NOW,
      TZ,
    );
    expect(h.inventory.map((i) => i.id)).toEqual(['saffron strands']);
    expect(h.inventory[0]).toMatchObject({ status: 'unknown', estimatedAmount: 'Bought once', purchaseFrequency: 'Not enough history yet' });
  });

  it('stops nagging about something the household stopped buying', () => {
    // Bought every 5 days in spring, then never again.
    const h = buildHousehold(
      [110, 105, 100].map((d) => order(daysAgo(d), [line('Nutella Hazelnut Spread', '350 g')])),
      [],
      NOW,
      TZ,
    );
    const spread = h.inventory.find((i) => i.id === 'chocolate spread')!;
    expect(spread).toMatchObject({ status: 'unknown', estimatedAmount: 'Not bought in a while', daysUntilLow: null });
    expect(h.shopping).toEqual([]);
  });

  it('puts items running low on the shopping list, with the reason', () => {
    const h = buildHousehold(milkOrders, [], NOW, TZ);
    expect(h.shopping).toHaveLength(1);
    expect(h.shopping[0]).toMatchObject({ name: 'Milk', emoji: '🥛', status: 'pending', reason: 'Every ~2 days · last bought yesterday' });
  });

  it('lists orders newest first for the history page, with a summary', () => {
    const h = buildHousehold(
      [order(daysAgo(40), [line('Amul Milk', '500 ml', 2, 56)], 56), order(daysAgo(0), [line('Amul Milk', '500 ml', 1, 28), line('Bread', '400 g', 1, 45)], 73)],
      [],
      NOW,
      TZ,
    );
    expect(h.history.map((e) => e.date)).toEqual(['Today', 'Aug 10']);
    // The line carries what it takes to buy the same thing again without
    // guessing at it: the canonical item, the app's own product name, the
    // pack and how many (History's "Buy this again").
    expect(h.history[0].items[1]).toEqual({
      item: 'bread',
      product: 'Bread',
      pack: '400 g',
      count: 1,
      name: 'Bread',
      emoji: '🍞',
      quantity: '400 g',
      price: 45,
    });
    expect(h.history[0].location).toBe('Home');
    expect(h.summary).toEqual({ orders: 2, items: 3, spend30d: 73 });
    expect(h.history[0].by).toBeUndefined(); // one person's orders: no names
  });

  it('shows an order still on its way in the history, and keeps it out of everything else until it arrives', () => {
    const delivered = order(daysAgo(3), [line('Amul Milk', '500 ml', 2, 56)], 56);
    const coming = { ...order(daysAgo(0), [line('Amul Milk', '500 ml', 1, 28)], 28), status: 'ACTIVE' };
    const h = buildHousehold([delivered, coming], [], NOW, TZ);
    expect(h.history.map((e) => e.onTheWay ?? false)).toEqual([true, false]);
    expect(h.summary.orders).toBe(1);
    expect(h.inventory.find((i) => i.id === 'milk')!.history).toHaveLength(1);
  });

  it("says who placed each order once several people's orders are combined, and predicts from all of them", () => {
    const mine = { ...order(daysAgo(6), [line('Amul Milk', '1 L')]), by: 'me@gmail.com' };
    const hers = [4, 2].map((n) => ({ ...order(daysAgo(n), [line('Amul Milk', '1 L')]), by: 'partner@gmail.com' }));
    const h = buildHousehold([mine, ...hers], [], NOW, TZ);
    expect(h.history.map((e) => e.by)).toEqual(['partner', 'partner', 'me']);
    expect(h.inventory.find((i) => i.id === 'milk')!.purchaseFrequency).toBe('Every ~2 days');
  });

  it('describes how the household shops, from its own orders', () => {
    const h = buildHousehold(milkOrders, [], NOW, TZ);
    expect(h.insight?.title).toBe('You shop for groceries about 4 times a week');
    expect(h.insight?.detail).toContain('Your most frequent purchase is milk.');
  });

  it('has no insight until there is something to say', () => {
    expect(buildHousehold([order(daysAgo(1), [line('Amul Milk', '500 ml')])], [], NOW, TZ).insight).toBeNull();
  });
});

describe('runsOutText', () => {
  it('words the days left, and never invents a number', () => {
    expect(runsOutText(null)).toBe('not enough history yet');
    expect(runsOutText(0)).toBe('any day now');
    expect(runsOutText(1)).toBe('tomorrow');
    expect(runsOutText(6)).toBe('~6 days');
  });
});

describe('runsOutIn', () => {
  it('finishes "likely to run out …", or says nothing without an estimate', () => {
    expect(runsOutIn(null)).toBeNull();
    expect(runsOutIn(0)).toBe('any day now');
    expect(runsOutIn(1)).toBe('tomorrow');
    expect(runsOutIn(2)).toBe('in ~2 days');
    expect(runsOutIn(3)).toBe('in ~3 days');
  });
});

describe('relativeDay', () => {
  it('says how long ago, in the household timezone', () => {
    expect(relativeDay(new Date(daysAgo(0)), NOW, TZ)).toBe('today');
    expect(relativeDay(new Date(daysAgo(1)), NOW, TZ)).toBe('yesterday');
    expect(relativeDay(new Date(daysAgo(5)), NOW, TZ)).toBe('5 days ago');
    expect(relativeDay(new Date(daysAgo(21)), NOW, TZ)).toBe('3 weeks ago');
    expect(relativeDay(new Date(daysAgo(70)), NOW, TZ)).toBe('2 months ago');
  });
});

describe('timeAgo', () => {
  it('is precise for recent times, then falls back to days', () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    expect(timeAgo(ago(20_000), NOW, TZ)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), NOW, TZ)).toBe('5 min ago');
    expect(timeAgo(ago(2 * 3_600_000), NOW, TZ)).toBe('2 hours ago');
    expect(timeAgo(ago(1 * 3_600_000), NOW, TZ)).toBe('1 hour ago');
    expect(timeAgo(ago(3 * 86_400_000), NOW, TZ)).toBe('3 days ago');
  });
});

// An estimate that rounds to nothing is not a measurement (household.ts).
describe('when the estimate runs out', () => {
  it('says it is probably used up rather than quoting zero', () => {
    // Bought one small pack a long time ago, used at a steady rate: the
    // arithmetic lands at or below nothing left.
    const h = buildHousehold(
      [order(daysAgo(60), [line('Nandini Milk', '500 ml', 1, 28)]), order(daysAgo(58), [line('Nandini Milk', '500 ml', 1, 28)]), order(daysAgo(56), [line('Nandini Milk', '500 ml', 1, 28)])],
      [],
      NOW,
      TZ,
    );
    const milk = h.inventory.find((i) => i.id === 'milk');
    if (milk) expect(milk.estimatedAmount).not.toMatch(/About 0(\.0+)? /);
  });

  // The words the household actually reads, checked directly: "About 0 g
  // left" sat on the same card as "Plenty", which read as a contradiction
  // and as precision nobody has.
  it('never renders a zero amount', () => {
    const h = buildHousehold(milkOrders, [], NOW, TZ);
    for (const item of h.inventory) expect(item.estimatedAmount).not.toMatch(/^About 0(\.0+)? /);
  });
});

// Pieces come out of formatQty with no unit after the number ("0", not
// "0 g"), and the zero test used to insist on a space - so "About 0 left"
// got through for sanitary pads while "About 0 g left" was caught.
describe('a count that has run to nothing', () => {
  it('says "Probably used up" for pieces too', () => {
    // 6 eggs every 3 days is 2 a day; the last 6 were bought 4 days ago.
    const h = buildHousehold(
      [order(daysAgo(13), [line('Eggs', '6 pieces')]), order(daysAgo(10), [line('Eggs', '6 pieces')]), order(daysAgo(7), [line('Eggs', '6 pieces')]), order(daysAgo(4), [line('Eggs', '6 pieces')])],
      [],
      NOW,
      TZ,
    );
    const eggs = h.inventory.find((i) => i.id === 'eggs')!;
    expect(eggs.estimatedAmount).not.toMatch(/About 0/);
    expect(eggs.estimatedAmount).toBe('Probably used up');
  });
});
