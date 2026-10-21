import { describe, expect, it } from 'vitest';
import { topUpForFreeDelivery, type TopUpCandidate } from './topup';

const c = (name: string, price: number, dueRatio: number | null = null): TopUpCandidate => ({ id: name, name, emoji: '', price, dueRatio });

const ask = (subtotal: number, candidates: TopUpCandidate[], threshold: number | null = 199, deliveryFee: number | null = 30) =>
  topUpForFreeDelivery({ subtotal, threshold, deliveryFee, candidates });

describe('topping a cart up to free delivery', () => {
  it('says how far short the cart is and what that saves', () => {
    const r = ask(187, [c('Curd', 25)]);
    expect(r?.gap).toBe(12);
    expect(r?.saves).toBe(30);
  });

  it('offers only what closes the gap on its own', () => {
    const r = ask(187, [c('Chewing gum', 5), c('Curd', 25)]);
    expect(r?.picks.map((p) => p.name)).toEqual(['Curd']);
  });

  it('never suggests spending more than the fee it saves', () => {
    // ₹150 of cheese to dodge a ₹30 fee is the store's interest, not theirs.
    const r = ask(187, [c('Cheese', 150)]);
    expect(r?.picks).toEqual([]);
    expect(r?.gap).toBe(12); // the gap is still worth saying
  });

  it('puts the cheapest first, then what they are most overdue for', () => {
    const r = ask(180, [c('Bread', 25, 0.5), c('Eggs', 25, 2), c('Milk', 20, 0.1)]);
    expect(r?.picks.map((p) => p.name)).toEqual(['Milk', 'Eggs', 'Bread']);
  });

  it('says nothing when the store has not told us its threshold', () => {
    expect(ask(187, [c('Curd', 25)], null)).toBeNull();
  });

  it('says nothing when no delivery fee is being charged', () => {
    expect(ask(187, [c('Curd', 25)], 199, 0)).toBeNull();
  });

  it('says nothing once the cart is over the line', () => {
    expect(ask(210, [c('Curd', 25)])).toBeNull();
  });
});
