// What an account can pay with, read from the vendor's own checkout
// (design §19 stage 2). Recorded from the real checkout on 2026-09-21.
import { describe, expect, it } from 'vitest';

import { readPaymentOptions } from '../src/worker/adapters/instamart-cart.js';

// The words the checkout actually used on the household's account, inside the
// envelope its own call is answered with (probed 2026-09-21).
const real = JSON.stringify({
  statusCode: 0,
  statusMessage: 'Executed Successfully',
  data: { codEnabled: true, smartPaymentApplied: true },
  sections: [
    { title: 'Credit & Debit Cards', rows: [{ title: 'Add New Card', subtitle: 'Save and Pay via Cards.' }] },
    {
      title: 'More Payment Options',
      rows: [
        { title: 'Wallets', subtitle: 'PhonePe, Amazon Pay & more' },
        { title: 'Netbanking', subtitle: 'Select from a list of banks' },
        { title: 'Pay on Delivery', subtitle: 'Pay in cash or pay online.' },
      ],
    },
  ],
});

describe('readPaymentOptions', () => {
  it('reads the kinds the checkout offers', () => {
    const kinds = readPaymentOptions(real).map((o) => o.kind).sort();
    expect(kinds).toEqual(['card', 'netbanking', 'on_delivery', 'wallet']);
  });

  // The one that decides whether an order can be placed with nobody there: a
  // card wants its CVV and then the bank's OTP, a wallet wants its own app,
  // netbanking wants a bank login. Only paying at the door needs none.
  it('knows which ones need a person', () => {
    const byKind = Object.fromEntries(readPaymentOptions(real).map((o) => [o.kind, o.needsPerson]));
    expect(byKind.on_delivery).toBe(false);
    expect(byKind.card).toBe(true);
    expect(byKind.wallet).toBe(true);
    expect(byKind.netbanking).toBe(true);
  });

  // Our own unsigned fetch of the same path is told "Session expired" with a
  // 200, so a status that is not a clear success has to mean "we do not
  // know", never "this account cannot pay any way at all".
  it('says nothing rather than guessing when the answer is unreadable', () => {
    expect(readPaymentOptions('')).toEqual([]);
    expect(readPaymentOptions('<html>signed out</html>')).toEqual([]);
    expect(readPaymentOptions(JSON.stringify({ statusCode: 999, statusMessage: 'Session expired. Please login again.' }))).toEqual([]);
  });

  // The one method the vendor states outright rather than in widget words.
  it('reads Pay on Delivery from the flag the vendor sets, not from words', () => {
    const off = JSON.stringify({ statusCode: 0, data: { codEnabled: false } });
    expect(readPaymentOptions(off).some((o) => o.kind === 'on_delivery')).toBe(false);
    const on = JSON.stringify({ statusCode: 0, data: { codEnabled: true } });
    expect(readPaymentOptions(on)).toEqual([{ kind: 'on_delivery', label: 'Pay on Delivery', needsPerson: false }]);
  });

  it('never lists the same kind twice, however often the words appear', () => {
    const many = JSON.stringify({ statusCode: 0, a: 'Cards', b: 'cards', c: 'Credit & Debit Cards' });
    expect(readPaymentOptions(many).filter((o) => o.kind === 'card')).toHaveLength(1);
  });
});
