// The app asks (design §9.12 Phase 4, §9.11): plain code notices, and only
// asks. Each check is proven on synthetic households.
import { describe, expect, it } from 'vitest';

import type { Fact } from './facts';
import type { ApiOrder } from './household';
import { buyingChange, guestsLeaving, suggestionsFor, wereYouAway } from './suggestions';

const TZ = 'Asia/Kolkata';
const TODAY = '2026-09-19';
const at = (day: string) => `${day}T06:00:00Z`;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let seq = 0;
const order = (day: string, milkLitres: number, by = 'me@x.com'): ApiOrder => ({
  vendor: 'instamart',
  orderId: `O${++seq}`,
  placedAt: at(day),
  total: 100,
  addressLabel: null,
  by,
  items: [
    { name: 'Amul Milk', count: milkLitres, pricePaid: 60, packLabel: '1 L' },
    { name: 'Farm Eggs', count: 1, pricePaid: 80, packLabel: '6 pieces' },
    { name: 'Carrot', count: 1, pricePaid: 40, packLabel: '500 g' },
  ],
});
// Every 2 days for 20 weeks back; from `change` on, `after` times the milk
// and eggs.
function household(change: string | null, after = 2): ApiOrder[] {
  const out: ApiOrder[] = [];
  for (let d = addDays(TODAY, -140); d < TODAY; d = addDays(d, 2)) {
    const more = change !== null && d >= change;
    const o = order(d, more ? after : 1);
    if (more) o.items[1] = { ...o.items[1], count: after };
    out.push(o);
  }
  return out;
}
let n = 0;
const fact = (kind: Fact['kind'], startsOn: string, details: Fact['details'] = {}, endsOn: string | null = null): Fact => ({
  id: `f${++n}`,
  kind,
  startsOn,
  endsOn,
  details,
  said: null,
  source: 'form',
  addedBy: null,
  createdAt: '2026-09-19T00:00:00Z',
});

describe('buyingChange', () => {
  it('notices buying roughly doubled since a week, and says since when', () => {
    const s = buyingChange(household('2026-08-03'), [], TODAY, TZ);
    expect(s).toMatchObject({ kind: 'buying_changed', direction: 'up', since: '2026-08-03' });
    expect((s as { ratio: number }).ratio).toBeGreaterThanOrEqual(1.5);
  });

  it('says nothing for a steady household', () => {
    expect(buyingChange(household(null), [], TODAY, TZ)).toBeNull();
  });

  it('notices buying dropping too', () => {
    expect(buyingChange(household('2026-08-03', 0.3), [], TODAY, TZ)).toMatchObject({ direction: 'down' });
  });

  it('does not ask when the household already said who lives here since', () => {
    expect(buyingChange(household('2026-08-03'), [fact('people', '2026-08-01', { count: 4 })], TODAY, TZ)).toBeNull();
  });

  it("does not ask when a member's orders simply started arriving", () => {
    const joined = household(null).concat(
      Array.from({ length: 20 }, (_, i) => order(addDays('2026-08-04', 2 * i), 1, 'wife@x.com')),
    );
    expect(buyingChange(joined, [], TODAY, TZ)).toBeNull();
  });

  it('asks only about recent changes', () => {
    expect(buyingChange(household('2026-06-01'), [], TODAY, TZ)).toBeNull(); // 15 weeks ago
  });
});

describe('guestsLeaving', () => {
  it('asks on the last day of a stay', () => {
    const stay = fact('guests', '2026-09-12', { count: 3 }, TODAY);
    expect(guestsLeaving([stay, fact('guests', '2026-09-12', { count: 1 }, '2026-09-25')], TODAY)).toEqual([{ id: `guests_leaving:${stay.id}`, kind: 'guests_leaving', fact: stay }]);
  });
});

describe('wereYouAway', () => {
  it('asks after longer without an order than ever before, and not after a usual gap', () => {
    const orders = household(null).filter((o) => o.placedAt < at('2026-09-01'));
    expect(wereYouAway(orders, [], TODAY, TZ)).toMatchObject({ kind: 'away', lastOrder: '2026-08-30', days: 20 });
    expect(wereYouAway(household(null), [], TODAY, TZ)).toBeNull();
  });

  it('does not ask once the household said it was away', () => {
    const orders = household(null).filter((o) => o.placedAt < at('2026-09-01'));
    expect(wereYouAway(orders, [fact('away', '2026-08-31')], TODAY, TZ)).toBeNull();
  });
});

describe('suggestionsFor', () => {
  it('does not also ask why an away household bought less', () => {
    const orders = household('2026-08-03', 0.3).filter((o) => o.placedAt < at('2026-09-01'));
    expect(suggestionsFor(orders, [], new Date(at(TODAY)), TZ).map((s) => s.kind)).toEqual(['away']);
  });
});
