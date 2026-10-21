import { describe, expect, it } from 'vitest';
import { deliveryTerms, inCartFromCart, missedFromCart, type CartBill, type CartLineResult, type CartJob } from './cart';

const line = (p: Partial<CartLineResult>): CartLineResult => ({
  item: 'milk',
  product: 'Amul Taaza',
  pack: '500 ml',
  wanted: 1,
  inCart: 1,
  state: 'added',
  price: null,
  note: null,
  ...p,
});

const job = (lines: CartLineResult[]): Pick<CartJob, 'result'> => ({ result: { lines } });

describe('what the filled cart holds', () => {
  it('names each thing that went in, with its count', () => {
    const r = inCartFromCart(job([line({ item: 'milk', inCart: 3 }), line({ item: 'tomato', inCart: 1 })]));
    expect(r.names).toEqual(['milk ×3', 'tomato']);
    expect(r.count).toBe(2);
  });

  it('counts what was already in the cart as in the cart', () => {
    expect(inCartFromCart(job([line({ item: 'bread', state: 'already_there', inCart: 2 })])).names).toEqual(['bread ×2']);
  });

  it('leaves out anything the store would not sell', () => {
    const lines = [line({ item: 'milk' }), line({ item: 'parsley', state: 'not_listed', inCart: 0 }), line({ item: 'curd', state: 'out_of_stock', inCart: 0 })];
    expect(inCartFromCart(job(lines)).names).toEqual(['milk']);
    expect(missedFromCart(job(lines)).names).toEqual(['parsley', 'curd']);
  });

  it('says nothing about a cart that has not run', () => {
    expect(inCartFromCart(null).names).toEqual([]);
    expect(missedFromCart(null).count).toBe(0);
  });
});

describe('what delivery costs at this store', () => {
  const job = (bill: Partial<CartBill> | null) => ({ result: bill ? { bill: bill as CartBill } : null });

  it('takes both figures from the last cart that knew them', () => {
    expect(deliveryTerms([job({ delivery: 30, freeDeliveryAbove: 199 })])).toEqual({ fee: 30, freeAbove: 199 });
  });

  it('reaches back past a cart that did not say', () => {
    // Newest first: the newest cart predates our reading the store's line.
    expect(deliveryTerms([job({ delivery: 25 }), job({ delivery: 30, freeDeliveryAbove: 199 })])).toEqual({ fee: 25, freeAbove: 199 });
  });

  it('keeps a delivery fee of zero, which is a fact and not a blank', () => {
    expect(deliveryTerms([job({ delivery: 0 })]).fee).toBe(0);
  });

  it('says nothing before the first cart', () => {
    expect(deliveryTerms([])).toEqual({ fee: null, freeAbove: null });
    expect(deliveryTerms([job(null)])).toEqual({ fee: null, freeAbove: null });
  });
});

describe('what the connection remembers about delivery', () => {
  const job = (bill: Partial<CartBill> | null) => ({ result: bill ? { bill: bill as CartBill } : null });

  // Before any cart this session, which is exactly when it is worth saying.
  it('falls back to what the store said on an earlier cart', () => {
    expect(deliveryTerms([], { fee: 30, freeAbove: 199 })).toEqual({ fee: 30, freeAbove: 199 });
  });

  it('prefers this session s cart, which is the fresher word', () => {
    expect(deliveryTerms([job({ delivery: 0, freeDeliveryAbove: 249 })], { fee: 30, freeAbove: 199 })).toEqual({ fee: 0, freeAbove: 249 });
  });

  it('takes each figure from wherever it is known', () => {
    // The cart charged a fee but carried no nudge; the threshold is the
    // remembered one.
    expect(deliveryTerms([job({ delivery: 30 })], { fee: null, freeAbove: 199 })).toEqual({ fee: 30, freeAbove: 199 });
  });

  it('says nothing when neither knows', () => {
    expect(deliveryTerms([], null)).toEqual({ fee: null, freeAbove: null });
  });
});
