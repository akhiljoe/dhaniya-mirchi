// The three pure answers the payment path turns on (design §19 stages 2-3).
// Each one is the last thing standing between the household and being charged
// something they did not agree to, so each is tested for what it refuses as
// much as for what it accepts.
import { bankAmountFrom } from '../src/worker/adapters/instamart-checkout.js';
import { describe, expect, it } from 'vitest';

import { cardName, chooseOtpBoxes, isBankPage, readItemCount, readOrderAnswer, readTotal, statusOfOrder, type OtpBox } from '../src/worker/adapters/instamart-checkout.js';
import { checkBeforePaying } from '../src/worker/pay.js';
import { ORDER_HARD_CAP_RUPEES } from '../src/constants.js';

describe('readTotal', () => {
  // The words the real payment screen used on 2026-09-21.
  it('reads the amount off the screen, as the household reads it', () => {
    expect(readTotal('1 item. Total: ₹94')).toBe(94);
    expect(readTotal('12 items. Total: ₹1,284')).toBe(1284);
    expect(readTotal('Total: Rs. 250.50')).toBe(250.5);
  });

  // An unreadable total must never become a number. It is what the
  // household's cap is checked against, and a guess here is a wrong charge.
  it('is null rather than a guess', () => {
    expect(readTotal(null)).toBeNull();
    expect(readTotal('')).toBeNull();
    expect(readTotal('1 item')).toBeNull();
    expect(readTotal('Total: ₹0')).toBeNull();
    expect(readTotal('Payment Options')).toBeNull();
  });
});

describe('readItemCount', () => {
  it('reads how many things the screen is about to charge for', () => {
    expect(readItemCount('1 item. Total: 94')).toBe(1);
    expect(readItemCount('12 items. Total: 1,284')).toBe(12);
  });

  it('is null rather than zero when the screen does not say', () => {
    expect(readItemCount(null)).toBeNull();
    expect(readItemCount('Total: 94')).toBeNull();
    expect(readItemCount('0 items. Total: 0')).toBeNull();
  });
});

describe('cardName', () => {
  // The real screen puts the name and the digits on two lines. Stored as it
  // comes, the name never matches again: the api tidies whitespace on the way
  // back, and the worker looks for a row whose text still has the newline.
  it('squashes the screen’s two lines into the one name everything else uses', () => {
    expect(cardName('Alex Bank Card\n1111')).toBe('Alex Bank Card 1111');
    expect(cardName('  Alex Bank \n 2222  ')).toBe('Alex Bank 2222');
  });
});

describe('readOrderAnswer', () => {
  // The fact the whole design turns on: the order exists before the money
  // moves, so these two answers have to be read apart.
  it('tells an order that exists from an order that was paid for', () => {
    expect(readOrderAnswer(JSON.stringify({ data: { order_id: '100000000000001', payment_status: 'PENDING' } }))).toEqual({
      orderId: '100000000000001',
      paid: false,
    });
    expect(readOrderAnswer(JSON.stringify({ data: { order_id: '100000000000001', payment_status: 'PAID' } }))).toEqual({
      orderId: '100000000000001',
      paid: true,
    });
  });

  // The first version looked only at `data.order_id` and came back empty on
  // a real order (2026-09-22), leaving a household with an order nobody could
  // name. It looks anywhere now.
  it('finds the order wherever the vendor puts it', () => {
    expect(readOrderAnswer(JSON.stringify({ data: { order: { orderId: '99', payment_status: 'PENDING' } } })).orderId).toBe('99');
    expect(readOrderAnswer(JSON.stringify({ result: [{ order_no: '77' }] })).orderId).toBe('77');
    expect(readOrderAnswer(JSON.stringify({ orderId: 12345 })).orderId).toBe('12345');
  });

  it('never reads a failure as paid', () => {
    expect(readOrderAnswer(JSON.stringify({ data: { order_id: '1', payment_status: 'FAILED' } }))).toEqual({ orderId: '1', paid: false });
    expect(readOrderAnswer('not json')).toEqual({ orderId: null, paid: false });
    expect(readOrderAnswer('{}')).toEqual({ orderId: null, paid: false });
  });
});

describe('statusOfOrder', () => {
  // The verdict cannot come from the call that placed the order: it answers
  // PENDING before the money moves. So afterwards the vendor's own list of
  // the household's orders is read, by id.
  const list = JSON.stringify({
    data: {
      orders: [
        { order_id: '100000000000002', order_status: 'FAILED', total: 130 },
        { order_id: '100000000000001', order_status: 'DELIVERED', total: 95 },
      ],
    },
  });

  it('finds the order the worker placed, by its id', () => {
    expect(statusOfOrder(list, '100000000000002')).toBe('FAILED');
    expect(statusOfOrder(list, '100000000000001')).toBe('DELIVERED');
  });

  // Never the newest order and hope: paying attention to the wrong order
  // would tell a household their payment went through when it did not.
  it('is null for an order that is not in the list', () => {
    expect(statusOfOrder(list, '999')).toBeNull();
    expect(statusOfOrder('not json', '999')).toBeNull();
    expect(statusOfOrder('{}', '999')).toBeNull();
  });

  it('says UNKNOWN rather than null when the order is there without a status', () => {
    expect(statusOfOrder(JSON.stringify({ orders: [{ order_id: '7' }] }), '7')).toBe('UNKNOWN');
  });
});

describe('chooseOtpBoxes', () => {
  // The bank's own 3-D Secure page is the one thing in this flow that nobody
  // here controls: every bank's differs and none of it is ours. So the box is
  // found by shape, and this is the guesswork, pulled out where it can be
  // tested without a bank.
  const box = (over: Partial<OtpBox> = {}): OtpBox => ({
    index: 0,
    type: 'text',
    name: null,
    id: null,
    placeholder: null,
    ariaLabel: null,
    maxLength: -1,
    visible: true,
    disabled: false,
    readOnly: false,
    ...over,
  });

  it('takes the box the bank named for the code', () => {
    const chosen = chooseOtpBoxes([box({ index: 0, name: 'cardholderName' }), box({ index: 1, name: 'otpValue' })], 6);
    expect(chosen.map((b) => b.index)).toEqual([1]);
  });

  // Many Indian banks split the code across one box per digit.
  it('fills one box per digit when the bank lays it out that way', () => {
    const digits = [0, 1, 2, 3, 4, 5].map((i) => box({ index: i, maxLength: 1 }));
    expect(chooseOtpBoxes(digits, 6).map((b) => b.index)).toEqual([0, 1, 2, 3, 4, 5]);
    // And takes only as many as the code is long.
    expect(chooseOtpBoxes(digits, 4).map((b) => b.index)).toEqual([0, 1, 2, 3]);
  });

  // A page marks what is not for you by hiding it or switching it off.
  // Typing a code into one of those is how a code goes nowhere.
  it('never types into a box that cannot be typed into', () => {
    expect(chooseOtpBoxes([box({ visible: false, name: 'otp' })], 6)).toEqual([]);
    expect(chooseOtpBoxes([box({ disabled: true, name: 'otp' })], 6)).toEqual([]);
    expect(chooseOtpBoxes([box({ readOnly: true, name: 'otp' })], 6)).toEqual([]);
    expect(chooseOtpBoxes([box({ type: 'hidden', visible: false })], 6)).toEqual([]);
  });

  it('prefers a named box that is long enough over a named one that is not', () => {
    const chosen = chooseOtpBoxes([box({ index: 0, name: 'otpShort', maxLength: 2 }), box({ index: 1, name: 'otp', maxLength: 6 })], 6);
    expect(chosen.map((b) => b.index)).toEqual([1]);
  });

  // Unnamed is not unusable - plenty of banks name nothing - but it is the
  // last resort, and only one that could hold the code.
  it('falls back to any box that could hold the code', () => {
    expect(chooseOtpBoxes([box({ index: 0, maxLength: 2 }), box({ index: 1, maxLength: 8 })], 6).map((b) => b.index)).toEqual([1]);
  });

  it('says nothing rather than guessing when there is no box at all', () => {
    expect(chooseOtpBoxes([], 6)).toEqual([]);
    expect(chooseOtpBoxes([box({ visible: false }), box({ disabled: true })], 6)).toEqual([]);
  });
});

describe('checkBeforePaying', () => {
  const agreed = { maxTotal: 100, address: 'Maple Residency' };

  it('lets through exactly what the household agreed to', () => {
    expect(checkBeforePaying({ total: 94, address: 'Maple Residency' }, agreed)).toBeNull();
    expect(checkBeforePaying({ total: 100, address: 'Maple Residency' }, agreed)).toBeNull();
  });

  // The cart can change under them - a price rises, a surge fee appears, the
  // vendor's app adds something. Nobody is charged more than the number they
  // saw when they tapped.
  it('stops an order that costs more than they agreed', () => {
    expect(checkBeforePaying({ total: 101, address: 'Maple Residency' }, agreed)).toBe('total_changed');
    expect(checkBeforePaying({ total: 9_999, address: 'Maple Residency' }, agreed)).toBe('total_changed');
  });

  it('stops when the total cannot be read at all', () => {
    expect(checkBeforePaying({ total: null, address: 'Maple Residency' }, agreed)).toBe('total_changed');
  });

  // Whatever the household typed, there is a ceiling. A wrong cart or a
  // mis-read total stops here.
  it('stops above the hard cap however high they set their own', () => {
    const generous = { maxTotal: ORDER_HARD_CAP_RUPEES * 10, address: null };
    expect(checkBeforePaying({ total: ORDER_HARD_CAP_RUPEES, address: null }, generous)).toBeNull();
    expect(checkBeforePaying({ total: ORDER_HARD_CAP_RUPEES + 1, address: null }, generous)).toBe('total_changed');
  });

  // A vendor keeps one cart per store and the store follows from the address.
  // Paying on a screen addressed somewhere else sends the food somewhere else.
  it('stops when the order would go to another address', () => {
    expect(checkBeforePaying({ total: 94, address: "Friend's" }, agreed)).toBe('wrong_address');
    expect(checkBeforePaying({ total: 94, address: '  Maple Residency  ' }, agreed)).toBeNull();
  });

  // The vendor's own app pushes its cart up whenever it has one, so between
  // Send and Pay the lines can change under them. A different cart that
  // happens to come to the same money is still not the one they agreed to.
  it('stops when the cart holds something other than what they looked at', () => {
    expect(checkBeforePaying({ total: 94, address: null, items: 3 }, { maxTotal: 100, address: null, lines: 1 })).toBe('cart_changed');
    expect(checkBeforePaying({ total: 94, address: null, items: 1 }, { maxTotal: 100, address: null, lines: 1 })).toBeNull();
  });

  // A count we do not have is not evidence of a change (design §9.3).
  it('does not invent a change when either count is unknown', () => {
    expect(checkBeforePaying({ total: 94, address: null, items: null }, { maxTotal: 100, address: null, lines: 1 })).toBeNull();
    expect(checkBeforePaying({ total: 94, address: null, items: 3 }, { maxTotal: 100, address: null, lines: null })).toBeNull();
  });

  // Nothing to compare against is not a mismatch: a household that has not
  // chosen an address yet is not sending its food to the wrong place.
  it('does not invent a mismatch when there is nothing to compare', () => {
    expect(checkBeforePaying({ total: 94, address: null }, agreed)).toBeNull();
    expect(checkBeforePaying({ total: 94, address: 'Anywhere' }, { maxTotal: 100, address: null })).toBeNull();
  });
});

// Which frame is the household's bank. This cannot be tried against a real
// bank on demand, and it decides whether a payment waits for an OTP - so it
// is pinned here instead. A run on 2026-09-22 stopped a checkout recording
// before the cart was filled because an ad pixel matched on "conversion".
describe('telling the bank from an advert', () => {
  const V = 'https://www.instamart.in';

  it('knows the banks and gateways by their host', () => {
    for (const url of [
      'https://acs.wibmo.com/v2/authenticate?txn=1',
      'https://secure.paytm.in/theia/api/v1/processTransaction',
      'https://api.juspay.in/txns/abc/3ds',
      'https://secure.razorpay.com/v1/checkout',
      'https://3ds.billdesk.com/pgidsk/PGIMerchantPayment',
    ]) {
      expect(isBankPage(url, V)).toBe(true);
    }
  });

  it('is not fooled by an advert that carries the same words', () => {
    for (const url of [
      // Google's own ad host contains "secure".
      'https://securepubads.g.doubleclick.net/gampad/ads?correlator=1',
      // And a conversion pixel carries them in its query string.
      'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/937732702/?en=conversion&authenticate=1',
      'https://www.google.com/pagead/1p-conversion/937732702/?secure=1',
      'https://www.googletagmanager.com/gtm.js?id=GTM-X&otp=1',
      'https://in.hotjar.com/c/site/1?challenge=1',
    ]) {
      expect(isBankPage(url, V)).toBe(false);
    }
  });

  it('never calls the vendor its own bank', () => {
    expect(isBankPage('https://www.instamart.in/checkout/secure', V)).toBe(false);
    expect(isBankPage('https://instamart.in/3ds', V)).toBe(false);
  });

  it('shrugs at a url it cannot read', () => {
    expect(isBankPage('not a url', V)).toBe(false);
    expect(isBankPage('', V)).toBe(false);
  });
});

// What the bank says it is taking, off its own page.
//
// Live, 2026-09-23: the app showed Rs 320 and the bank asked for Rs 255,
// because one item left the order after the household had agreed to a price.
// This is the only figure in the flow that cannot be stale, and it is shown
// beside the box where they type the code - so a wrong one here would be
// worse than none at all.
describe('the amount on the bank page', () => {
  it('reads the plain statements a 3-D Secure page makes', () => {
    expect(bankAmountFrom('Merchant BLINKIT Amount INR 255.00 Enter OTP')).toBe(255);
    expect(bankAmountFrom('Transaction Amount: Rs. 1,299')).toBe(1299);
    expect(bankAmountFrom('Total ₹255 will be debited')).toBe(255);
    expect(bankAmountFrom('INR 255 will be debited from your card')).toBe(255);
  });

  it('says nothing rather than pick a number out of a page it did not understand', () => {
    expect(bankAmountFrom('Enter the OTP sent to your registered mobile')).toBeNull();
    expect(bankAmountFrom('Card ending 1111')).toBeNull();
    expect(bankAmountFrom('')).toBeNull();
  });

  it('refuses a zero', () => {
    expect(bankAmountFrom('Amount INR 0')).toBeNull();
  });
});

// Live, 2026-09-23: three things sent, cheese sent after, the sheet showed
// the store's Rs 608 and the household tapped Pay on it - and the order was
// refused because the store's cart had nine lines where the first send had
// counted three. The count stands in for "is this the cart they meant"; a
// figure they read off the screen and chose is the thing itself.
describe('a count that disagrees with a figure the household chose', () => {
  it('does not stop a payment for the exact figure on the Pay button', () => {
    expect(checkBeforePaying({ total: 608, address: null, items: 9 }, { maxTotal: 608, address: null, lines: 3 })).toBeNull();
  });
  it('does not stop a payment for the exact figure they agreed to when asked', () => {
    expect(checkBeforePaying({ total: 608, address: null, items: 9 }, { maxTotal: 522, address: null, lines: 3, agreed: 608 })).toBeNull();
  });
  it('still stops when the count differs and the figure is not one they chose', () => {
    expect(checkBeforePaying({ total: 500, address: null, items: 9 }, { maxTotal: 608, address: null, lines: 3 })).toBe('cart_changed');
  });
});
