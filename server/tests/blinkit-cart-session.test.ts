// Blinkit as a cart the app can fill (blinkit-cart-session.ts): the pure parts.
//
// The one that matters is which search result goes in the cart. Asked for
// "Bread", the first version put a ten rupee pineapple sweet-fill bread roll
// in a real cart, because it took the cheapest thing under the word. That is
// adding blind, and these tests are the rule against it.
import { describe, expect, it } from 'vitest';

import type { BlinkitCartItem } from '../src/worker/adapters/blinkit-cart.js';
import { phoneFromStorage, pickBlinkitProduct } from '../src/worker/adapters/blinkit-cart-session.js';

const item = (product_name: string, unit: string, price: number, product_id = Math.floor(Math.random() * 1e6)): BlinkitCartItem => ({
  product_id,
  merchant_id: 40523,
  product_name,
  quantity: 1,
  price,
  unit,
});

// What the store actually returned for "bread" on 2026-09-23.
const breadResults = [
  item('Modern Pineapple Sweet Fill Bread Roll', '50 g', 10),
  item('English Oven Sandwich Bread', '400 g', 60),
  item('English Oven Sandwich Bread', '700 g', 95),
  item('Britannia Brown Bread', '400 g', 55),
];

describe('which result goes in the cart', () => {
  it('takes the household s own product, not the cheapest thing under the word', () => {
    // This is the pineapple bread roll case.
    const pick = pickBlinkitProduct(breadResults, { product: 'English Oven Sandwich Bread', pack: '400 g' });
    expect(pick?.product_name).toBe('English Oven Sandwich Bread');
    expect(pick?.unit).toBe('400 g');
  });

  it('prefers the pack the household buys, and settles for another pack of the same product', () => {
    expect(pickBlinkitProduct(breadResults, { product: 'English Oven Sandwich Bread', pack: '700 g' })?.unit).toBe('700 g');
    // No 200 g sold here: the same product in another pack, which the result
    // then reports back so nothing goes in unseen.
    const other = pickBlinkitProduct(breadResults, { product: 'English Oven Sandwich Bread', pack: '200 g' });
    expect(other?.product_name).toBe('English Oven Sandwich Bread');
    expect(other?.unit).toBe('400 g'); // the cheaper of the two on offer
  });

  it('says not listed rather than substituting when the product is not there', () => {
    // A household that buys Harvest Gold gets nothing, not a bread roll.
    expect(pickBlinkitProduct(breadResults, { product: 'Harvest Gold White Bread', pack: '400 g' })).toBeNull();
  });

  it('matches on words, not on the vendor spelling the name exactly the same', () => {
    expect(pickBlinkitProduct(breadResults, { product: 'english oven sandwich bread 400g', pack: '' })?.product_name).toBe('English Oven Sandwich Bread');
    expect(pickBlinkitProduct(breadResults, { product: 'Britannia brown bread', pack: '400 g' })?.product_name).toBe('Britannia Brown Bread');
  });

  it('reads pack sizes the way people write them', () => {
    const milk = [item('Amul Taaza Toned Milk', '1 ltr', 77), item('Amul Taaza Toned Milk', '500 ml', 29)];
    expect(pickBlinkitProduct(milk, { product: 'Amul Taaza Toned Milk', pack: '1 l' })?.unit).toBe('1 ltr');
    expect(pickBlinkitProduct(milk, { product: 'Amul Taaza Toned Milk', pack: '500ml' })?.unit).toBe('500 ml');
  });

  it('takes the cheapest in stock only for a search, where there is no product of theirs to match', () => {
    // A recipe's new ingredient: never bought, so "whatever the store sells
    // under that name, cheapest first" is the honest reading.
    expect(pickBlinkitProduct(breadResults, { product: 'bread', pack: '', match: 'search' })?.price).toBe(10);
    // And when there is no product name at all.
    expect(pickBlinkitProduct(breadResults, { product: '', pack: '' })?.price).toBe(10);
  });

  it('has nothing to pick from an empty answer', () => {
    expect(pickBlinkitProduct([], { product: 'English Oven Sandwich Bread', pack: '400 g' })).toBeNull();
    expect(pickBlinkitProduct([], { product: 'bread', pack: '', match: 'search' })).toBeNull();
  });
});

describe('the account s phone number, which zpaykit insists on', () => {
  // Only the last four digits are stored by us, on purpose, so the number
  // comes from the page's own `auth` entry.
  it('reads it out of the page s auth entry', () => {
    expect(phoneFromStorage(JSON.stringify({ accessToken: 'x', phoneNumber: '9123454567' }))).toBe('9123454567');
  });

  it('has none when the entry is missing or holds no Indian mobile number', () => {
    expect(phoneFromStorage(null)).toBeNull();
    expect(phoneFromStorage(JSON.stringify({ accessToken: 'x' }))).toBeNull();
    expect(phoneFromStorage(JSON.stringify({ phoneNumber: '12345' }))).toBeNull();
  });
});
