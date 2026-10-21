// The Insights page's numbers (design §12.7): counted from the orders, in the
// household's timezone, never guessed.
import { describe, expect, it } from 'vitest';

import type { ApiOrder } from './household';
import { buildInsights, feesFrom, unevenHistoryNote } from './insights';

const NOW = new Date('2026-09-19T10:00:00Z'); // 3:30 pm in Kolkata
const TZ = 'Asia/Kolkata';
const DAY = 86_400_000;

let seq = 0;
function order(daysAgo: number, names: string[], total = 100, by: string | null = null, hourUtc = 6): ApiOrder {
  const d = new Date(NOW.getTime() - daysAgo * DAY);
  d.setUTCHours(hourUtc, 30, 0, 0);
  return {
    vendor: 'instamart',
    orderId: `O${++seq}`,
    placedAt: d.toISOString(),
    total,
    addressLabel: null,
    by,
    items: names.map((name) => ({ name, count: 1, pricePaid: total / names.length, packLabel: null })),
  };
}

describe('buildInsights', () => {
  it('adds up spend by calendar month in the household timezone, the current month marked partial', () => {
    // 2026-08-31 20:00 UTC is Sep 1, 01:30 in Kolkata: September's.
    const late = { ...order(0, ['Amul Milk'], 300), placedAt: '2026-08-31T20:00:00Z' };
    const i = buildInsights([order(40, ['Amul Milk'], 200), late], [], NOW, TZ);
    expect(i.months).toHaveLength(12);
    expect(i.months[11]).toMatchObject({ key: '2026-09', label: 'Sep', spend: 300, orders: 1, partial: true });
    expect(i.months[10]).toMatchObject({ key: '2026-08', spend: 200, orders: 1, partial: false });
    expect(i.months[0].key).toBe('2025-10');
  });

  it('compares the last 30 days with the 30 before, and says nothing when there was nothing before', () => {
    // Over all time the trend keeps its own 30-day window: there is no
    // "before all time" to compare against.
    expect(buildInsights([order(5, ['Milk'], 150), order(40, ['Milk'], 100)], [], NOW, TZ, null).trend).toEqual({ recent: 150, before: 100, changePct: 50 });
    expect(buildInsights([order(5, ['Milk'], 150)], [], NOW, TZ, null).trend.changePct).toBeNull();
  });

  it('the trend follows the chosen window, and compares it with the window before it', () => {
    const orders = [order(5, ['Milk'], 150), order(40, ['Milk'], 100), order(200, ['Milk'], 70)];
    const year = buildInsights(orders, [], NOW, TZ, 365);
    expect(year.trendDays).toBe(365);
    expect(year.trend.recent).toBe(320); // everything inside the year
    const month = buildInsights(orders, [], NOW, TZ, 30);
    expect(month.trendDays).toBe(30);
    expect(month.trend).toEqual({ recent: 150, before: 100, changePct: 50 });
  });

  it('counts only the orders inside the chosen window', () => {
    const orders = [order(5, ['Milk'], 150), order(200, ['Milk'], 70)];
    expect(buildInsights(orders, [], NOW, TZ, 30).orders).toBe(1);
    expect(buildInsights(orders, [], NOW, TZ, 365).orders).toBe(2);
    expect(buildInsights(orders, [], NOW, TZ, null).orders).toBe(2);
  });

  it('says where each app history starts, counted from every order and not from the window', () => {
    const blinkit = { ...order(900, ['Milk'], 70), vendor: 'blinkit' };
    const instamart = { ...order(100, ['Milk'], 80), vendor: 'instamart' };
    const i = buildInsights([blinkit, instamart], [], NOW, TZ, 30);
    // Both apps are named even though neither order is inside a 30-day window:
    // the note exists to explain what the window leaves out.
    expect(i.history.map((h) => h.vendor)).toEqual(['blinkit', 'instamart']);
    expect(i.orders).toBe(0);
  });

  it('counts orders by weekday and time of day, in the household timezone', () => {
    // NOW is a Saturday. 06:30 UTC = 12:00 in Kolkata (midday); 15:30 UTC = 21:00 (evening).
    const i = buildInsights([order(0, ['Milk']), order(1, ['Milk'], 100, null, 15)], [], NOW, TZ);
    expect(i.weekdays.find((w) => w.label === 'Sat')!.orders).toBe(1);
    expect(i.weekdays.find((w) => w.label === 'Fri')!.orders).toBe(1);
    expect(i.dayparts.find((d) => d.label === 'Midday')!.orders).toBe(1);
    expect(i.dayparts.find((d) => d.label === 'Evening')!.orders).toBe(1);
  });

  it('puts products the catalog does not know with the small categories', () => {
    const i = buildInsights([order(1, ['Amul Milk', 'Mystery Gadget'], 200)], [], NOW, TZ);
    expect(i.categories).toEqual([
      { label: 'Dairy & eggs', spend: 100, share: 0.5 },
      { label: 'Everything else', spend: 100, share: 0.5 },
    ]);
  });

  it('splits spend by kind, and leaves non-groceries out', () => {
    const i = buildInsights([order(1, ['Amul Milk', 'Onion'], 200), order(2, ['Google Pay Gift Card'], 500)], [], NOW, TZ);
    expect(i.categories).toEqual([
      { label: 'Dairy & eggs', spend: 100, share: 0.5 },
      { label: 'Fruits & vegetables', spend: 100, share: 0.5 },
    ]);
  });

  it('finds items bought together far more often than chance, with how often', () => {
    const orders = [
      ...Array.from({ length: 6 }, (_, k) => order(k * 3 + 1, ['Cheese Slices', 'Chicken Salami'])),
      ...Array.from({ length: 6 }, (_, k) => order(k * 3 + 2, ['Amul Milk'])),
    ];
    const i = buildInsights(orders, [], NOW, TZ);
    expect(i.together).toEqual([{ a: 'Cheese', b: 'Salami', times: 6, lift: 2 }]);
  });

  it("shows each item's usual gap, and what the household stopped buying", () => {
    const milk = Array.from({ length: 10 }, (_, k) => order(k * 2 + 1, ['Amul Milk']));
    // Mango every 7 days in spring, not since.
    const mango = Array.from({ length: 6 }, (_, k) => order(120 + k * 7, ['Alphonso Mango']));
    const i = buildInsights([...milk, ...mango], [], NOW, TZ);
    expect(i.rhythm[0]).toMatchObject({ name: 'Milk', everyDays: 2, trips: 10 });
    expect(i.rhythm.map((r) => r.name)).not.toContain('Mango');
    expect(i.stopped).toEqual([{ name: 'Mango', emoji: '🥭', everyDays: 7, lastBought: 'May 22, 2026' }]);
  });

  it('calls something new only with enough history before it', () => {
    const old = order(300, ['Amul Milk']);
    const butter = [30, 20, 10, 5].map((d) => order(d, ['Amul Butter']));
    expect(buildInsights([old, ...butter], [], NOW, TZ).newHabits).toEqual([{ name: 'Butter', emoji: '🧈', trips: 4, since: 'Aug 20, 2026' }]);
    expect(buildInsights(butter, [], NOW, TZ).newHabits).toEqual([]);
  });

  it("says who orders only when several people's orders are combined", () => {
    const one = buildInsights([order(1, ['Milk'], 100, 'me@gmail.com')], [], NOW, TZ);
    expect(one.members).toEqual([]);
    const two = buildInsights([order(1, ['Milk'], 100, 'me@gmail.com'), order(2, ['Milk'], 300, 'partner@gmail.com'), order(3, ['Milk'], 50, 'partner@gmail.com')], [], NOW, TZ);
    expect(two.members).toEqual([
      { name: 'partner', orders: 2, spend: 350, share: 2 / 3 },
      { name: 'me', orders: 1, spend: 100, share: 1 / 3 },
    ]);
  });
});

describe('unevenHistoryNote', () => {
  const NOW_D = new Date(NOW);
  const history = [
    { vendor: 'blinkit', since: 'Sep 22, 2023', sinceAt: new Date(NOW_D.getTime() - 1100 * 86_400_000).toISOString() },
    { vendor: 'instamart', since: 'Sep 19, 2025', sinceAt: new Date(NOW_D.getTime() - 366 * 86_400_000).toISOString() },
  ];

  it('says nothing when one app is all there is', () => {
    expect(unevenHistoryNote([history[0]], null, 30, NOW_D)).toBeNull();
  });

  it('warns when the window itself reaches past an app history', () => {
    const note = unevenHistoryNote(history, null, 30, NOW_D);
    expect(note).toContain('not a fair comparison');
  });

  // The live case on 2026-09-20: a 12-month window fits both apps, but the
  // 12 months it is measured against hold no Instamart at all, and the page
  // showed "+154%" as though spending had leapt.
  it('warns when the window fits but the period compared against does not', () => {
    const note = unevenHistoryNote(history, 365, 365, NOW_D);
    expect(note).toContain("one app's history running out");
  });

  it('says nothing when every app covers the whole comparison', () => {
    expect(unevenHistoryNote(history, 30, 30, NOW_D)).toBeNull();
  });

  it('uses the names the household sees', () => {
    const note = unevenHistoryNote(history, null, 30, NOW_D, (v) => (v === 'blinkit' ? 'Blinkit' : 'Swiggy Instamart'));
    expect(note).toContain('Swiggy Instamart orders here start');
  });
});

describe('feesFrom', () => {
  const TZ_IN = 'Asia/Kolkata';
  // total 120 with 100 of goods = 20 of delivery and handling.
  const o = (at: string, total: number, itemPrice: number | null) => ({
    vendor: 'instamart',
    orderId: at,
    placedAt: at,
    total,
    addressLabel: null,
    items: [{ name: 'Milk', count: 1, pricePaid: itemPrice, packLabel: '1 l' }],
  });
  const many = (n: number, day: string, total = 120, price = 100) =>
    Array.from({ length: n }, (_, k) => o(`${day}T0${k % 9}:00:00Z`, total, price));

  it('counts what the apps charged on top of the goods', () => {
    const f = feesFrom(many(20, '2026-09-01'), TZ_IN)!;
    expect(f.total).toBe(400); // 20 orders x 20
    expect(f.perOrder).toBe(20);
    expect(f.orders).toBe(20);
  });

  // A second trip on the same day pays a second fee, which is the part worth
  // acting on: on the household's real year, the extra trips carried a few thousand rupees.
  it('counts the extra trips of a day separately', () => {
    const orders = [...many(10, '2026-09-01'), ...many(10, '2026-09-02')];
    const f = feesFrom(orders, TZ_IN)!;
    expect(f.daysWithExtraTrips).toBe(2);
    expect(f.extraTrips).toBe(18); // 9 extra on each day
    expect(Math.round(f.onExtraTrips)).toBe(360);
  });

  // Days are the household's own, not UTC: an order at 1am in Kolkata belongs
  // to that day, not to the one before.
  it('groups by the household day', () => {
    const late = o('2026-09-01T19:30:00Z', 120, 100); // 2026-09-02 01:00 in Kolkata
    const f = feesFrom([...many(20, '2026-09-02'), late], TZ_IN)!;
    expect(f.daysWithExtraTrips).toBe(1);
    expect(f.extraTrips).toBe(20);
  });

  it('never reads a discount as a negative fee', () => {
    const f = feesFrom([...many(19, '2026-09-01'), o('2026-09-01T10:00:00Z', 80, 100)], TZ_IN)!;
    expect(f.total).toBe(19 * 20);
  });

  // An order whose lines carry no prices says nothing: counting its whole
  // total as a fee would invent a number (design §9.3).
  it('leaves out orders with no line prices, and says how much it covered', () => {
    const f = feesFrom([...many(20, '2026-09-01'), o('2026-09-01T11:00:00Z', 500, null)], TZ_IN)!;
    expect(f.orders).toBe(20);
    expect(f.covered).toBeCloseTo(20 / 21, 2);
  });

  it('says nothing at all when there is too little to go on', () => {
    expect(feesFrom(many(5, '2026-09-01'), TZ_IN)).toBeNull();
    expect(feesFrom([], TZ_IN)).toBeNull();
  });
});

describe('where the money goes', () => {
  // A category averages the story away: on the household's real year "Snacks,
  // 8%" was 81% chocolate and "Pantry, 15%" was mostly olive oil. The items
  // are the part worth naming.
  it('names the items the money went on, biggest first', () => {
    const orders = [
      order(5, ['Amul Paneer'], 1200),
      order(6, ['Amul Paneer'], 800),
      order(7, ['Borges Olive Oil'], 1500),
      order(8, ['Tata Salt'], 30),
    ];
    const i = buildInsights(orders, [], NOW, TZ, null);
    // Paneer twice (2000) outranks the one bottle of olive oil (1500), and the
    // two purchases of it are one line, not two.
    expect(i.topSpend[0]!.name.toLowerCase()).toContain('paneer');
    expect(i.topSpend[0]!.spend).toBe(2000);
    expect(i.topSpend[1]!.name.toLowerCase()).toContain('olive oil');
    expect(i.topSpend.map((t) => t.spend)).toEqual([...i.topSpend.map((t) => t.spend)].sort((a, b) => b - a));
  });

  it('adds up to the whole, with the tail counted rather than dropped', () => {
    // Twelve things the catalog tells apart, so the tail is real.
    const names = ['Milk', 'Bread', 'Eggs', 'Rice', 'Atta', 'Sugar', 'Tea', 'Instant Coffee', 'Curd', 'Butter', 'Cheese', 'Tata Salt'];
    const orders = names.map((n, k) => order(k + 1, [n], (k + 1) * 10));
    const i = buildInsights(orders, [], NOW, TZ, null);
    const shownShare = i.topSpend.reduce((n, t) => n + t.share, 0);
    expect(shownShare + i.topSpendRest.share).toBeCloseTo(1, 5);
    expect(i.topSpend.length + i.topSpendRest.kinds).toBe(names.length);
  });

  it('says nothing about a household with no prices rather than zero rupees', () => {
    const i = buildInsights([order(5, ['Milk'], 0)], [], NOW, TZ, null);
    expect(i.topSpend).toEqual([]);
  });
});
