// Blinkit's cart, the pure parts (blinkit-cart.ts). The store follows the
// session's coordinates, not the account, so these decide which shop a
// household's order is filled from - a restored session points at the
// vendor's Gurugram default, and this household is in Bengaluru.
import { describe, expect, it } from 'vitest';

import { addToCartItems, locationFor, readCartState, readMerchantId, readOrderToken, readValidation } from '../src/worker/adapters/blinkit-cart.js';
import type { VendorAddress } from '../src/worker/adapters/instamart-catalog.js';

const home: VendorAddress = { id: '100000001', label: 'Home', display: 'Somewhere', lat: 12.971600, lng: 77.594600, name: 'A Household' };

describe('what to put in the cart', () => {
  // The shape is the vendor's own: a product card carries its own
  // `atc_action`, which is used verbatim rather than rebuilt from parts.
  const card = (id: number, name: string, over: Record<string, unknown> = {}) => ({
    atc_action: { add_to_cart: { cart_item: { product_id: id, merchant_id: 40523, product_name: name, quantity: 1, price: 27, unit: '500 ml', ...over } } },
  });

  it('finds the items however deeply the widgets nest them', () => {
    const answer = { data: { widgets: [{ items: [card(1, 'Nandini Toned Milk')] }, { grid: { rows: [[card(2, 'Amul Taaza')]] } }] } };
    expect(addToCartItems(answer).map((i) => i.product_name)).toEqual(expect.arrayContaining(['Nandini Toned Milk', 'Amul Taaza']));
    expect(addToCartItems(answer)).toHaveLength(2);
  });

  it('ignores anything that is not a product card', () => {
    expect(addToCartItems({ atc_action: { add_to_cart: {} } })).toEqual([]);
    expect(addToCartItems({ atc_action: { add_to_cart: { cart_item: { product_name: 'no id' } } } })).toEqual([]);
    expect(addToCartItems(null)).toEqual([]);
    expect(addToCartItems('not an object')).toEqual([]);
  });
});

describe('which store the session points at', () => {
  it('reads the merchant the page resolved', () => {
    expect(readMerchantId(JSON.stringify({ id: 40523 }))).toBe(40523);
  });

  it('says nothing rather than guessing when it has not resolved one', () => {
    expect(readMerchantId(null)).toBeNull();
    expect(readMerchantId('not json')).toBeNull();
    expect(readMerchantId(JSON.stringify({}))).toBeNull();
    expect(readMerchantId(JSON.stringify({ id: 'x' }))).toBeNull();
  });

  it('asks for the household s own coordinates, and says they are not a default', () => {
    // `isDefault: true` is what a restored session carries, with the
    // vendor's Gurugram coordinates. The page believes it, and every cart is
    // then filled a thousand kilometres away.
    const coords = JSON.parse(locationFor(home)).coords;
    expect(coords).toMatchObject({ isDefault: false, lat: 12.971600, lon: 77.594600, addressId: 100000001 });
  });

  it('carries the label the household would recognise', () => {
    expect(JSON.parse(locationFor(home)).coords.locality).toBe('Home');
    expect(JSON.parse(locationFor({ ...home, label: '' })).coords.locality).toBe('');
  });
});

describe('what the vendor says is in the cart', () => {
  // The shape is the real one, from a fill against the live account on
  // 2026-09-22: one line of Amul Taaza at quantity 2, billed at 107 for 34
  // rupees of milk.
  const answer = (over: Record<string, unknown> = {}, bill: Record<string, unknown> = {}) =>
    JSON.stringify({
      cart_data: {
        id: 3956371992,
        items: [
          { product_id: 113945, name: 'Amul Taaza Toned Milk', quantity: 2, price: 17, mrp: 17, unit: '200 ml', unavailable_quantity: 0 },
        ],
        bill_details: {
          payable_amount: 107,
          total_cost: 34,
          delivery_charge: 30,
          additional_charge: 43,
          free_delivery_mov: 250,
          total_items: 2,
          unavailable_items: 0,
          ...bill,
        },
        ...over,
      },
    });

  it('counts the lines the cart holds, not the times a product is echoed', () => {
    // The whole reason this reads `cart_data.items`: a product comes back
    // inside several widgets, and walking the answer counted one line six
    // times.
    const state = readCartState(200, answer());
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toEqual({
      productId: 113945,
      name: 'Amul Taaza Toned Milk',
      quantity: 2,
      price: 17,
      unit: '200 ml',
      unavailableQuantity: 0,
    });
  });

  it('takes the bill from the vendor and never adds one up', () => {
    // 34 of milk is payable at 107: 30 delivery and a 43 rupee charge nobody
    // announced. Summing the lines here would understate it by two thirds.
    const state = readCartState(200, answer());
    expect(state).toMatchObject({ cartId: 3956371992, total: 107, subtotal: 34, deliveryFee: 30, freeDeliveryAbove: 250 });
  });

  it('says nothing rather than zero when the bill is silent', () => {
    // A null total must stay null: zero reads as "free", and a cart that
    // claims to cost nothing is the one thing worse than no answer.
    const state = readCartState(200, answer({}, { payable_amount: null, free_delivery_mov: undefined }));
    expect(state.ok).toBe(true);
    expect(state.total).toBeNull();
    expect(state.freeDeliveryAbove).toBeNull();
  });

  it('carries what the store cannot supply', () => {
    const state = readCartState(
      200,
      answer({ items: [{ product_id: 1, name: 'Paneer', quantity: 2, price: 95, unit: '200 g', unavailable_quantity: 2 }] }, { unavailable_items: 2 }),
    );
    expect(state.lines[0].unavailableQuantity).toBe(2);
    expect(state.unavailableUnits).toBe(2);
  });

  it('drops a row it cannot identify instead of inventing one', () => {
    const state = readCartState(200, answer({ items: [{ name: 'no id', quantity: 1 }, { product_id: 7, name: 'Rice', quantity: 0 }] }));
    expect(state.lines).toEqual([]);
    expect(state.ok).toBe(true);
  });

  it('is not ok when the vendor refused, or answered with something else', () => {
    for (const bad of [readCartState(422, answer()), readCartState(200, 'not json'), readCartState(200, '{"ok":true}')]) {
      expect(bad.ok).toBe(false);
      expect(bad.cartId).toBeNull();
      expect(bad.total).toBeNull();
      expect(bad.lines).toEqual([]);
    }
  });
});

describe('what the store says about delivering the cart', () => {
  // Shape from the real validate answer (2026-09-22): the bill lives in the
  // same `cart_data` a fill returns, beside the address the cart is bound to.
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      cart_id: 3900000002,
      cart_data: {
        id: 3900000002,
        address: { id: 100000001 },
        merchant_status: [{ is_serviceable: true }],
        items: [{ product_id: 113945, name: 'Amul Taaza Toned Milk', quantity: 1, price: 17, unit: '200 ml', unavailable_quantity: 0 }],
        bill_details: { payable_amount: 90, total_cost: 17, delivery_charge: 30, free_delivery_mov: 250, unavailable_items: 0 },
        ...over,
      },
    });

  it('reads the cart it was asked about, and the address it is bound to', () => {
    const v = readValidation(200, body());
    expect(v).toMatchObject({ ok: true, cartId: 3900000002, addressId: 100000001, serviceable: true });
    expect(v.cart.total).toBe(90);
    expect(v.cart.lines).toHaveLength(1);
  });

  it('is serviceable only when every merchant says so', () => {
    // Half a cart that cannot be delivered is not a cart that can be.
    expect(readValidation(200, body({ merchant_status: [{ is_serviceable: true }, { is_serviceable: false }] })).serviceable).toBe(false);
    expect(readValidation(200, body({ merchant_status: [{ is_serviceable: true }, { is_serviceable: true }] })).serviceable).toBe(true);
  });

  it('says nothing rather than yes when the vendor did not answer', () => {
    // null is "it did not say". Reading that as serviceable is how a cart
    // gets filled at a store that will never deliver it.
    expect(readValidation(200, body({ merchant_status: [] })).serviceable).toBeNull();
    expect(readValidation(200, body({ merchant_status: [{}] })).serviceable).toBeNull();
    expect(readValidation(200, body({ merchant_status: 'nonsense' })).serviceable).toBeNull();
  });

  it('has no address to check against when the vendor omitted one', () => {
    expect(readValidation(200, body({ address: {} })).addressId).toBeNull();
    expect(readValidation(422, body()).ok).toBe(false);
    expect(readValidation(200, 'not json').ok).toBe(false);
  });
});

describe('the token that comes before the money', () => {
  // The real answer: { response: { payments_info, access_token, expires_in,
  // expiry_time_in_epoch }, orderHash }. No order id, twice measured.
  const body = (over: Record<string, unknown> = {}, resp: Record<string, unknown> = {}) =>
    JSON.stringify({
      orderHash: 'a1b2c3d4e5f6',
      response: { payments_info: {}, access_token: 'SECRET_TOKEN_VALUE', expires_in: 900, expiry_time_in_epoch: 1790000000, ...resp },
      ...over,
    });

  it('carries the hash and the token the payment call needs', () => {
    const t = readOrderToken(200, body());
    expect(t).toEqual({ ok: true, orderHash: 'a1b2c3d4e5f6', paymentToken: 'SECRET_TOKEN_VALUE', expiresAtEpoch: 1790000000, orderId: null });
  });

  it('reports no order, because this call places none', () => {
    // The whole reason Blinkit's dry run can make this call at all.
    expect(readOrderToken(200, body()).orderId).toBeNull();
  });

  it('notices an order id if the vendor ever starts sending one', () => {
    // If this ever fires, an order exists before the money does, and every
    // rule Instamart taught us applies to Blinkit too.
    expect(readOrderToken(200, body({ order_id: 'ORD123' })).orderId).toBe('ORD123');
    expect(readOrderToken(200, body({}, { order_id: 4567 })).orderId).toBe('4567');
  });

  it('is not ok when the vendor refused, and holds nothing it did not get', () => {
    for (const bad of [readOrderToken(500, body()), readOrderToken(200, 'not json'), readOrderToken(200, '{}')]) {
      expect(bad.orderHash).toBeNull();
      expect(bad.paymentToken).toBeNull();
    }
    expect(readOrderToken(500, body()).ok).toBe(false);
  });
});
