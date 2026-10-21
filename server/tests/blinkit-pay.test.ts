// Paying for a Blinkit cart, the pure parts (blinkit-pay.ts).
//
// Every shape here is from the real checkout captured on 2026-09-22, and
// every field in it is money or a secret. These tests exist because the chain
// cannot be tried on demand: making it run costs a real payment.
import { describe, expect, it } from 'vitest';

import {
  defaultPaymentFields,
  findOrderForCart,
  verdictForCart,
  readDefaultPayment,
  readPaymentIntent,
  readPaymentMethod,
  readPaymentStart,
  zpaykitForm,
} from '../src/worker/adapters/blinkit-pay.js';

// The household's own preferred card, as zpaykit really describes it: what
// is SHOWN on the method, what is needed to PAY one level down in
// `default_payment_object.card`. Reading only the top level gave every card a
// null token and no CVV length.
const card = {
  card_id: 100000006,
  card_token: 'VAULT_TOKEN_VALUE',
  vault: 'winecellar',
  card_name: 'Amex American Express Card',
  card_type: 'american_express',
  card_status: 'active',
  valid_for_payment: 1,
  issuing_bank: 'AMEX',
  last_four_digits: '1111',
  first_six_digits: '370987',
  card_expiry_month: 9,
  card_expiry_year: 2046,
  cvv_length: 4,
  disable_cvv_page: 0,
  show_old_cvv_page: 0,
};

const amex = {
  payment_method_id: 100000006,
  payment_method_type: 'card',
  display_text: 'Amex American Express Card',
  subtitle: '****** 1111',
  payment_category: 'online_payments',
  default_payment_object: { card },
};

describe('the way the household already pays', () => {
  const body = (overCard: Record<string, unknown> = {}, overMethod: Record<string, unknown> = {}) =>
    JSON.stringify({
      response: { user_preferred_payment: { ...amex, ...overMethod, default_payment_object: { card: { ...card, ...overCard } } } },
    });

  it('digs the paying parts out of the card, not the method', () => {
    expect(readDefaultPayment(200, body())).toEqual({
      methodId: '100000006',
      methodType: 'card',
      cardToken: 'VAULT_TOKEN_VALUE',
      vault: 'winecellar',
      label: 'Amex American Express Card',
      lastFour: '1111',
      issuingBank: 'AMEX',
      cvvLength: 4,
      cvvWanted: true,
      usable: true,
    });
  });

  it('takes the code length from the card, never a default', () => {
    // Four for this household's Amex, three for an ordinary card. A four
    // digit code typed into a box validated for three is a decline on an
    // order that already has an id.
    expect(readDefaultPayment(200, body())?.cvvLength).toBe(4);
    expect(readDefaultPayment(200, body({ cvv_length: 3 }))?.cvvLength).toBe(3);
    // Not said is not three.
    expect(readDefaultPayment(200, body({ cvv_length: undefined }))?.cvvLength).toBeNull();
  });

  it('reads the vendor double negative the right way round', () => {
    // disable_cvv_page 0 means a code IS wanted. Backwards, the payment is
    // made without a code the gateway is waiting for.
    expect(readDefaultPayment(200, body({ disable_cvv_page: 0 }))?.cvvWanted).toBe(true);
    expect(readDefaultPayment(200, body({ disable_cvv_page: 1 }))?.cvvWanted).toBe(false);
    // Silence means ask. Skipping a code nobody said to skip fails the payment.
    expect(readDefaultPayment(200, body({ disable_cvv_page: undefined }))?.cvvWanted).toBe(true);
  });

  it('believes the vendor when it says a card cannot be used', () => {
    // A card the bank has since killed is a decline on an order that already
    // exists, so both of the vendor's own words have to agree.
    expect(readDefaultPayment(200, body({ valid_for_payment: 0 }))?.usable).toBe(false);
    expect(readDefaultPayment(200, body({ card_status: 'blocked' }))?.usable).toBe(false);
    // Silence is not a refusal: an older answer carrying neither is usable.
    expect(readDefaultPayment(200, body({ valid_for_payment: undefined, card_status: undefined }))?.usable).toBe(true);
  });

  it('has no method rather than half of one', () => {
    // No id is no method. The `card_id` fallback is for reading a card out of
    // the LIST, where the row itself is the card; it does not rescue a
    // preferred-payment block that never named a method.
    expect(readDefaultPayment(200, body({}, { payment_method_id: undefined }))).toBeNull();
    expect(readDefaultPayment(200, JSON.stringify({ response: {} }))).toBeNull();
    expect(readDefaultPayment(500, body())).toBeNull();
    expect(readDefaultPayment(200, 'not json')).toBeNull();
  });

  it('reads a card out of the list, where the row is the card itself', () => {
    // getPaymentMethods lists cards directly rather than under a preferred
    // method, so the id comes from the card and there is no display text.
    const fromList = readPaymentMethod(card)!;
    expect(fromList).toMatchObject({ methodId: '100000006', cardToken: 'VAULT_TOKEN_VALUE', lastFour: '1111', cvvLength: 4, label: 'Amex American Express Card' });
  });

  it('never carries the part of the number the vendor does hand over', () => {
    // `first_six_digits` plus `last_four_digits` is ten digits of a fifteen
    // digit card. The reader has no use for the first six and does not take
    // them (design §7.6).
    const read = readPaymentMethod(amex)!;
    expect(JSON.stringify(read)).not.toContain('370987');
    expect(read.lastFour).toBe('1111');
  });
});

describe('the price the gateway will actually be asked for', () => {
  // The real answer: a live order id and a payable amount, both before any
  // money moves.
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      zomato_payment_hash_meta: {
        payment_hash: 'HASH_VALUE',
        payments_info: { country_id: 1, service_type: 'BLINKIT' },
        cart_id: 3900000001,
        order_id: 1000000001,
        skip_payment_client_request: false,
        payable_amount: 379,
        ...over,
      },
    });

  it('carries the order id the vendor has already minted', () => {
    // Recorded the moment it is seen. An order id exists from here on, so a
    // failure after this is "an order may exist", never "it failed".
    expect(readPaymentIntent(200, body())).toMatchObject({
      ok: true,
      orderId: '1000000001',
      payableAmount: 379,
      cartId: '3900000001',
    });
  });

  it('carries the hash without making it part of anything shown', () => {
    const intent = readPaymentIntent(200, body());
    expect(intent.paymentHash).toBe('HASH_VALUE');
    expect(Object.keys(intent)).toEqual(['ok', 'orderId', 'payableAmount', 'cartId', 'paymentHash']);
  });

  it('refuses to invent a price', () => {
    // A null amount stops the payment. Zero would read as free.
    expect(readPaymentIntent(200, body({ payable_amount: undefined })).payableAmount).toBeNull();
    expect(readPaymentIntent(200, body({ payable_amount: null })).payableAmount).toBeNull();
  });

  it('is not ok when the vendor settled nothing', () => {
    for (const bad of [readPaymentIntent(500, body()), readPaymentIntent(200, 'not json'), readPaymentIntent(200, '{}')]) {
      expect(bad.ok).toBe(false);
      expect(bad.orderId).toBeNull();
      expect(bad.payableAmount).toBeNull();
    }
  });
});

describe('what the gateway says when the payment starts', () => {
  const body = (over: Record<string, unknown> = {}, tx: Record<string, unknown> = {}) =>
    JSON.stringify({
      response: {
        status: 'pending',
        message: 'Payment is being processed',
        transaction: {
          status: 'pending',
          track_id: 'ZTBLIN3D268C2F8DA643',
          checkout_url: 'https://zpay.zomato.com//v2/razorpay/3dsecure/initiate?track_id=X',
          response_url: 'https://x',
          ...tx,
        },
        gateway_type: 'razorpay',
        is_3d_secure_payment: '1',
        ...over,
      },
    });

  it('knows the bank is about to ask', () => {
    expect(readPaymentStart(200, body())).toMatchObject({
      ok: true,
      status: 'pending',
      gateway: 'razorpay',
      needsBank: true,
      trackId: 'ZTBLIN3D268C2F8DA643',
    });
  });

  it('reads the vendor string 1, not a boolean', () => {
    // The vendor sends "1". Testing it as true would say no bank is coming,
    // and the worker would stop waiting for an OTP the household just got.
    expect(readPaymentStart(200, body({ is_3d_secure_payment: '1' })).needsBank).toBe(true);
    expect(readPaymentStart(200, body({ is_3d_secure_payment: '0' })).needsBank).toBe(false);
    expect(readPaymentStart(200, body({ is_3d_secure_payment: undefined })).needsBank).toBe(false);
  });

  it('says nothing useful rather than guessing when the answer is not one', () => {
    expect(readPaymentStart(500, body()).ok).toBe(false);
    expect(readPaymentStart(200, 'not json').ok).toBe(false);
    expect(readPaymentStart(200, '{}').ok).toBe(false);
  });
});

describe('what zpaykit is asked', () => {
  it('sends a form, because zpaykit does not read JSON', () => {
    expect(zpaykitForm({ country_id: '1', service_type: 'BLINKIT' })).toBe('country_id=1&service_type=BLINKIT');
  });

  it('asks about the amount the cart actually costs', () => {
    // The vendor decides which methods to offer from this, so it is the
    // cart's own figure and not a rounded one.
    const f = defaultPaymentFields('9123454567', 379);
    expect(f).toMatchObject({
      country_id: '1',
      service_type: 'BLINKIT',
      phone: '9123454567',
      amount: '379',
      criteria: 'last_used_global',
    });
  });
});

describe('whether the order we paid for actually exists', () => {
  // The real numbers from the payment that went through on 2026-09-23. Three
  // different ids are involved and only one of them ties anything together.
  const PAYMENT_ORDER_ID = '1000000002'; // what zomato_payment_hash answered
  const HISTORY_ORDER_ID = '1000000003'; // what the vendor's own list calls it
  const CART_ID = '3900000001'; // the cart both attempts were for

  const stubs = [
    { orderId: HISTORY_ORDER_ID, cartId: CART_ID, status: 'DELIVERED', total: 394 },
    { orderId: '1000000004', cartId: '3899236435', status: 'DELIVERED', total: 325 },
  ];

  it('finds the order by the cart, which is the only id that matches', () => {
    expect(findOrderForCart(stubs, CART_ID)).toEqual({ orderId: HISTORY_ORDER_ID, status: 'DELIVERED', total: 394 });
  });

  it('would never have found it by the payment order id', () => {
    // This is the whole reason the rule changed. §19 said "matched by order
    // id", and the payment's id appears nowhere in the vendor's list.
    expect(stubs.some((s) => s.orderId === PAYMENT_ORDER_ID)).toBe(false);
    expect(findOrderForCart(stubs, PAYMENT_ORDER_ID)).toBeNull();
  });

  it('says placed only when the vendor says so', () => {
    expect(verdictForCart(stubs, CART_ID)).toEqual({ state: 'placed', order: { orderId: HISTORY_ORDER_ID, status: 'DELIVERED', total: 394 } });
  });

  it('says unconfirmed, never failed, when the order is not there yet', () => {
    // A just-paid order is a tracking card for some minutes before it becomes
    // a row in the list. Reading that as failure is how a household pays
    // twice.
    const v = verdictForCart(stubs, '9999999999');
    expect(v).toEqual({ state: 'unconfirmed' });
    expect(JSON.stringify(v)).not.toContain('fail');
  });

  it('passes the vendor status word through rather than mapping it', () => {
    // ENROUTE, DELIVERED, and whatever else it uses. A word we have not seen
    // is not a word to guess at.
    const enroute = [{ orderId: HISTORY_ORDER_ID, cartId: CART_ID, status: 'ENROUTE', total: null }];
    expect(verdictForCart(enroute, CART_ID)).toMatchObject({ state: 'placed', order: { status: 'ENROUTE', total: null } });
  });

  it('matches a cart id given as a number', () => {
    expect(findOrderForCart(stubs, Number(CART_ID))?.orderId).toBe(HISTORY_ORDER_ID);
  });
});
