// Blinkit's checkout, behind the shared interface (blinkit-checkout.ts).
//
// The part tested here is the verdict: what the app is allowed to tell a
// household after their money may have moved. It cannot be tried on demand -
// making it run costs a real payment - so it is tested against the shapes the
// vendor really answers with.
import { describe, expect, it } from 'vitest';

import { BlinkitCheckout } from '../src/worker/adapters/blinkit-checkout.js';
import { isCancelControl, totalFromCheckout } from '../src/worker/adapters/blinkit-page.js';
import type { BlinkitPaySession } from '../src/worker/adapters/blinkit-pay.js';
import type { Page } from 'playwright-core';

const CART_ID = '3900000001';
const HISTORY_ORDER_ID = '1000000003';

// The vendor's own list shape, as `stubsFromList` reads it.
function historyBody(status: string, cartId = CART_ID): string {
  return JSON.stringify({
    response: {
      snippets: [
        {
          widget_type: 'order_history_container_vr',
          tracking: { common_attributes: { order_id: HISTORY_ORDER_ID, order_status: status } },
          data: { identity: { id: `order_${HISTORY_ORDER_ID}_${cartId}` }, items: [] },
        },
      ],
    },
  });
}

function checkoutWith(history: { status: number; body: string }) {
  return new BlinkitCheckout({
    pay: {} as BlinkitPaySession,
    zomato: {} as Page,
    blinkitCall: async () => history,
    cartId: CART_ID,
    cartLines: 2,
    addressLabel: 'Home',
    phone: '9123454567',
  });
}

describe('what we are allowed to say became of the order', () => {
  it('says paid when the vendor is delivering it or has', async () => {
    for (const word of ['DELIVERED', 'ENROUTE', 'ARRIVING', 'PLACED']) {
      const out = await checkoutWith({ status: 200, body: historyBody(word) }).outcome();
      expect(out).toEqual({ orderId: HISTORY_ORDER_ID, paid: true, unknown: false });
    }
  });

  it('says not paid only when the vendor says the order is dead', async () => {
    for (const word of ['CANCELLED', 'FAILED', 'REFUNDED']) {
      const out = await checkoutWith({ status: 200, body: historyBody(word) }).outcome();
      expect(out).toMatchObject({ paid: false, unknown: false });
    }
  });

  it('says unknown for a word it has never seen, rather than guessing', async () => {
    const out = await checkoutWith({ status: 200, body: historyBody('SOME_NEW_STATE') }).outcome();
    expect(out).toMatchObject({ paid: false, unknown: true });
  });

  it('says unknown when the order is not in the list yet', async () => {
    // A just-paid order is a tracking card for some minutes before it becomes
    // a row. Reading that as failure is how a household pays twice.
    const out = await checkoutWith({ status: 200, body: historyBody('DELIVERED', '9999999999') }).outcome();
    expect(out).toMatchObject({ paid: false, unknown: true });
  });

  it('says unknown when the vendor would not answer at all', async () => {
    for (const bad of [
      { status: 500, body: '' },
      { status: 200, body: 'not json' },
    ]) {
      const out = await checkoutWith(bad).outcome();
      expect(out).toMatchObject({ paid: false, unknown: true });
    }
  });

  it('never reports a failure it is not sure of', async () => {
    // The rule this whole function exists for: `paid: false` with
    // `unknown: true` means "we could not tell", and the caller must say so.
    const out = await checkoutWith({ status: 503, body: '' }).outcome();
    expect(out.paid).toBe(false);
    expect(out.unknown).toBe(true);
  });
});

describe('what it refuses to do', () => {
  it('will not claim a pay-on-delivery this account was never offered', async () => {
    // Claiming one that is not there would strand an order unpaid.
    await expect(checkoutWith({ status: 200, body: historyBody('DELIVERED') }).payOnDelivery()).rejects.toThrow();
  });

  it('will not pay for a card it was never given', async () => {
    await expect(checkoutWith({ status: 200, body: historyBody('DELIVERED') }).pay(null)).rejects.toThrow();
  });

  it('assumes a code is wanted until a card says otherwise', async () => {
    // With no card read yet there is nothing to go on, and assuming no code
    // is the dangerous direction: it would pay without one.
    expect(await checkoutWith({ status: 200, body: historyBody('DELIVERED') }).cvvNeeded()).toBe(true);
  });
});

// What the household will actually be charged, off the vendor's own checkout.
//
// Live, 2026-09-23, order 1000000005: the app agreed 320 and the bank asked
// for 255. The reader took whichever label came first in the page text, and
// "Item Total" came before "To Pay". Sixty-five rupees in the household's
// favour that time; the same fault reads the other way just as easily, and
// paying a number nobody saw is the thing this is built to prevent.
describe('the figure the checkout will charge', () => {
  it('prefers what is payable over a total that is part of the bill', () => {
    expect(totalFromCheckout('Item Total ₹320 Delivery ₹0 To Pay ₹255')).toBe(255);
    expect(totalFromCheckout('Sub Total ₹320 Amount Payable ₹255')).toBe(255);
    expect(totalFromCheckout('MRP Total ₹400 Grand Total ₹255')).toBe(255);
  });

  it('reads a plain total when nothing qualifies it', () => {
    expect(totalFromCheckout('Total ₹255 Pay Now')).toBe(255);
  });

  it('never reads a part of the bill as the bill', () => {
    expect(totalFromCheckout('Item Total ₹320')).toBeNull();
    expect(totalFromCheckout('Sub Total ₹320 Bill Total ₹320')).toBeNull();
  });

  it('reads the vendor s own wording on its button', () => {
    expect(totalFromCheckout('Pay Now ₹255')).toBe(255);
    expect(totalFromCheckout('₹255 to pay')).toBe(255);
  });

  it('says nothing rather than guessing', () => {
    expect(totalFromCheckout('Choose a payment method')).toBeNull();
  });
});

// Which control gets out of a payment.
//
// Pressed on the bank's own page, which is nobody here's to control, and at a
// moment when a real order already exists. Pressing the wrong thing on that
// screen is not a small mistake, so the words are tested rather than trusted.
describe('the way out of a payment', () => {
  it('takes the words that mean stop this payment', () => {
    expect(isCancelControl('Cancel')).toBe(true);
    expect(isCancelControl('CANCEL PAYMENT')).toBe(true);
    expect(isCancelControl('Cancel Transaction')).toBe(true);
    expect(isCancelControl('Go Back')).toBe(true);
    expect(isCancelControl('Return to Merchant')).toBe(true);
  });

  it('never takes cancelling the ORDER, which is a different and bigger thing', () => {
    expect(isCancelControl('Cancel order')).toBe(false);
    expect(isCancelControl('Cancel the order')).toBe(false);
  });

  it('never takes something that is only about cancelling', () => {
    expect(isCancelControl('Cancellation policy')).toBe(false);
    expect(isCancelControl('Cancellation reason')).toBe(false);
    expect(isCancelControl('Terms of cancellation')).toBe(false);
  });

  it('ignores a whole paragraph that happens to contain the word', () => {
    expect(isCancelControl('You may cancel this transaction at any time before ' + 'x'.repeat(60))).toBe(false);
    expect(isCancelControl('')).toBe(false);
  });

  it('does not take a word that merely contains it', () => {
    expect(isCancelControl('Cancelled')).toBe(false);
  });
});
