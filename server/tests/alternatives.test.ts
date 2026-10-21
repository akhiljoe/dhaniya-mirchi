// The next product down when the store has not got the first.
//
// What goes in a household's cart when their first choice is missing. Each
// rule here decides between putting in something they have bought before and
// putting in nothing, so each is pinned.
import { describe, expect, it } from 'vitest';

import { setWithAlternatives } from '../src/worker/adapters/alternatives.js';
import type { CartLineResult, CartWant } from '../src/worker/adapters/instamart-cart.js';

const want: CartWant = {
  item: 'milk',
  product: 'Nandini Toned Milk',
  pack: '500 ml',
  qty: 2,
  match: 'exact',
  alternatives: [
    { product: 'Nandini Toned Milk', pack: '1 ltr' },
    { product: 'Amul Taaza Toned Milk', pack: '500 ml' },
  ],
};

// A store that answers by product and pack.
function store(answers: Record<string, Partial<CartLineResult>>) {
  const asked: string[] = [];
  return {
    asked,
    async set(w: CartWant): Promise<CartLineResult> {
      const key = `${w.product} ${w.pack}`;
      asked.push(key);
      const a = answers[key] ?? { state: 'not_listed', inCart: 0 };
      return { item: w.item, product: w.product, pack: w.pack, wanted: w.qty, inCart: 0, state: 'added', price: null, note: null, ...a };
    },
  };
}

describe('taking the next product down', () => {
  it('takes the first choice when the store has it, and asks nothing more', async () => {
    const s = store({ 'Nandini Toned Milk 500 ml': { state: 'added', inCart: 2 } });
    const got = await setWithAlternatives(s, want);
    expect(got.state).toBe('added');
    expect(got.note).toBeNull();
    expect(s.asked).toEqual(['Nandini Toned Milk 500 ml']);
  });

  it('takes the next ranked product when the first pack is not sold here', async () => {
    // Real: the 500 ml was "packs here: 1 ltr"; the household buys the 1 ltr too.
    const s = store({
      'Nandini Toned Milk 500 ml': { state: 'not_listed', inCart: 0, note: 'packs here: 1 ltr' },
      'Nandini Toned Milk 1 ltr': { state: 'added', inCart: 2, price: 56 },
    });
    const got = await setWithAlternatives(s, want);
    expect(got.state).toBe('added');
    expect(got.pack).toBe('1 ltr');
    expect(got.note).toBe('instead of Nandini Toned Milk');
  });

  it('walks past one that is out of stock to one that is in', async () => {
    const s = store({
      'Nandini Toned Milk 1 ltr': { state: 'out_of_stock', inCart: 0 },
      'Amul Taaza Toned Milk 500 ml': { state: 'added', inCart: 2 },
    });
    const got = await setWithAlternatives(s, want);
    expect(got.product).toBe('Amul Taaza Toned Milk');
    expect(s.asked).toHaveLength(3);
  });

  it('says the first answer when nothing down the list is there either', async () => {
    const s = store({ 'Nandini Toned Milk 500 ml': { state: 'not_listed', inCart: 0, note: 'packs here: 2 ltr' } });
    const got = await setWithAlternatives(s, want);
    expect(got.state).toBe('not_listed');
    expect(got.note).toBe('packs here: 2 ltr');
    expect(got.product).toBe('Nandini Toned Milk');
  });

  it('does not try another product for a failure that is not about the product', async () => {
    // The store has it; a button did not work. A different milk fixes nothing.
    const s = store({ 'Nandini Toned Milk 500 ml': { state: 'failed', inCart: 0, note: 'the product is not on the page' } });
    const got = await setWithAlternatives(s, want);
    expect(got.state).toBe('failed');
    expect(s.asked).toEqual(['Nandini Toned Milk 500 ml']);
  });

  it('never hands the alternatives on to the store', async () => {
    const seen: CartWant[] = [];
    const s = {
      async set(w: CartWant): Promise<CartLineResult> {
        seen.push(w);
        return { item: w.item, product: w.product, pack: w.pack, wanted: w.qty, inCart: 0, state: 'not_listed', price: null, note: null };
      },
    };
    await setWithAlternatives(s, want);
    expect(seen.every((w) => w.alternatives === undefined)).toBe(true);
  });
});
