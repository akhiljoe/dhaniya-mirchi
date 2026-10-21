// Blinkit's payment screen, behind the same interface Instamart's sits behind
// (design §19 stages 2-3, Appendix A).
//
// Nothing about it is a screen. Instamart signs its own page's requests, so
// its checkout is driven by pressing the vendor's own buttons; Blinkit
// accepts our fetch, and its payment is not even Blinkit's - it is Zomato's
// zpaykit on another origin, with Razorpay behind that. What both have in
// common is only the questions `pay.ts` asks, which is exactly why those
// questions are an interface.
//
// The order of things here is forced by one fact: `zomato_payment_hash` both
// settles the price AND mints a real order id, and it is the only place the
// true payable amount can be read. The cart's own bill is lower - 379 at the
// cart against 394 at the gateway on the captured payment - so the number the
// household agrees to has to come from the settle, and the settle has to
// happen before they are asked. That is safe here in a way it would not be on
// Instamart: the order does not appear until the money moves (measured twice,
// Appendix A).
import type { Page } from 'playwright-core';

import {
  BLINKIT_ORIGIN,
  CHECKOUT_SCREEN_TIMEOUT_MS,
  PAGE_LOAD_TIMEOUT_MS,
  ZPAYKIT_MAKE_PAYMENT_PATH,
  ZPAYKIT_ORIGIN,
} from '../../constants.js';
import type { Checkout, PaymentScreen, PayResult } from './checkout.js';
import { CartError } from './instamart-cart.js';
import { typeOtpIntoBankPage, type OtpPageShape } from './instamart-checkout.js';
import type { BlinkitPaymentIntent, BlinkitPaymentMethod, BlinkitPaySession } from './blinkit-pay.js';
import { readPaymentStart, verdictForCart, zpaykitForm } from './blinkit-pay.js';
import { stubsFromList } from '../import/blinkit-parse.js';

export interface BlinkitCheckoutInput {
  pay: BlinkitPaySession;
  // A page on zomato.com, which is where zpaykit will answer, and where the
  // bank's page is reached from.
  zomato: Page;
  // Asks Blinkit's own endpoints, for the verdict afterwards.
  blinkitCall: (path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown) => Promise<{ status: number; body: string }>;
  cartId: string;
  // How many lines the cart held when the household looked at it, and where
  // it goes. Both are checked by pay.ts before anything is spent.
  cartLines: number | null;
  addressLabel: string | null;
  phone: string;
}

export class BlinkitCheckout implements Checkout {
  private readonly input: BlinkitCheckoutInput;
  // The methods zpaykit offered, by the words the household's own screen uses.
  private methods: BlinkitPaymentMethod[] = [];
  private chosen: BlinkitPaymentMethod | null = null;
  // What the settle answered for the chosen method. Holds the order id, so it
  // is kept the moment it exists.
  private intent: BlinkitPaymentIntent | null = null;
  private trackId: string | null = null;

  constructor(input: BlinkitCheckoutInput) {
    this.input = input;
  }

  // An order id exists from the settle onwards, whether or not the payment
  // works. pay.ts records this on every failure path.
  get placedOrderId(): string | null {
    return this.intent?.orderId ?? null;
  }

  otpPageShape: OtpPageShape = [];

  // What is about to be charged.
  //
  // The total is the gateway's own figure, taken from the settle rather than
  // from the cart, because they differ and the smaller one is the wrong one
  // to put in front of a household.
  async open(): Promise<PaymentScreen> {
    const amount = 0;
    const preferred = await this.input.pay.preferredCard(this.input.phone, amount);
    this.methods = await this.input.pay.cards(this.input.phone, amount);
    if (preferred && !this.methods.some((m) => m.methodId === preferred.methodId)) this.methods.unshift(preferred);
    // Settling needs a method, so the preferred one is used to read the
    // price. Choosing a different card settles again.
    const forPrice = preferred ?? this.methods[0] ?? null;
    if (forPrice) {
      this.chosen = forPrice;
      this.intent = await this.input.pay.settle(this.input.cartId, forPrice);
    }
    return {
      total: this.intent?.payableAmount ?? null,
      items: this.input.cartLines,
      address: this.input.addressLabel,
      // Only cards this account can actually use are offered: a card the bank
      // has killed is a decline on an order that already exists.
      cards: this.methods.filter((m) => m.usable).map((m) => m.label),
      // Blinkit's own checkout offers no pay-on-delivery to this account, and
      // claiming one that is not there would strand an order unpaid.
      onDelivery: false,
    };
  }

  async chooseCard(label: string): Promise<void> {
    const found = this.methods.find((m) => m.label === label && m.usable);
    if (!found) throw new CartError('card_not_found');
    if (this.chosen?.methodId !== found.methodId || !this.intent?.ok) {
      this.chosen = found;
      // A different card is a different settle: the gateway prices per
      // method, and paying against another card's hash is not something to
      // find out afterwards.
      this.intent = await this.input.pay.settle(this.input.cartId, found);
    }
  }

  // Does this card want its code?
  //
  // The vendor's own answer, and it is yes for this household's Amex:
  // `disable_cvv_page: 0`, `cvv_length: 4`. An earlier version of this
  // returned a flat false because no request in the captured payment carried
  // a CVV anywhere - not `makePayment`, not `gateway_info`, which was `{}`.
  // That was reading absence in a recording as absence in the flow, and the
  // household had watched themselves type one: the payment page showed the
  // cards, the CVV box was blank, and the Pay button only became live once
  // the code was in.
  //
  // So a CVV is required and we still do not know where it goes. It is not
  // in any call we have seen, and the box it is typed into belongs to the
  // vendor's own checkout page - which cannot be reached for a cart we filled
  // by API, because that page renders its own copy of the cart and ours is
  // invisible to it (measured 2026-09-23: filled through our call, then the
  // cart page loaded fresh, and it said the cart was empty).
  async cvvNeeded(): Promise<boolean> {
    return this.chosen?.cvvWanted ?? true;
  }

  // Spend the money.
  //
  // `cvv` is accepted to satisfy the interface and is not sent: no field in
  // this vendor's payment call has ever carried one. A card that wants a code
  // is refused above rather than paid for without it.
  async pay(_cvv: string | null): Promise<PayResult> {
    const method = this.chosen;
    const intent = this.intent;
    if (!method) throw new CartError('card_not_found');
    // A card that wants its code, and no field in this vendor's payment call
    // has ever carried one. Sending the payment anyway would spend the
    // household's money on a request the card is likely to decline, AFTER an
    // order id has already been minted. Refusing here costs nothing: nothing
    // has been pressed yet.
    if (method.cvvWanted) throw new CartError('no_cvv_box');
    if (!intent?.ok || !intent.paymentHash || intent.payableAmount === null) throw new CartError('internal');

    const pressedAt = new Date();
    const form = zpaykitForm({
      payment_method_id: method.methodId,
      payment_method_type: method.methodType,
      card_token: method.cardToken ?? '',
      card_vault: method.vault ?? '',
      service_type: 'BLINKIT',
      order_type: 'BLINKIT',
      country_id: '1',
      order_id: intent.orderId ?? '',
      amount: String(intent.payableAmount),
      host_redirect_url: `${BLINKIT_ORIGIN}/`,
      payments_hash: intent.paymentHash,
      phone: this.input.phone,
      email: '',
    });
    const r = await this.input.pay.makePayment(form);
    const started = readPaymentStart(r.status, r.body);
    this.trackId = started.trackId;

    // The bank's page is reached through the url the gateway hands back. It
    // is followed, never shown, and only when it is the gateway's own.
    if (started.needsBank && started.checkoutUrl) {
      await this.input.zomato
        .goto(started.checkoutUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS })
        .catch(() => undefined);
    }
    return {
      pressedAt,
      orderId: intent.orderId,
      // Never read as paid here: this call answers before the money moves,
      // exactly like Instamart's. The verdict comes from `outcome()`.
      paid: false,
      bankAsked: started.needsBank,
      // This path drives the gateway's own calls rather than a bank page, so
      // there is no page to read an amount off.
      bankTotal: null,
    };
  }

  // Blinkit's checkout offered this account no pay-on-delivery, so there is
  // nothing honest to press.
  async payOnDelivery(): Promise<PayResult> {
    throw new CartError('internal');
  }

  async submitOtp(otp: string): Promise<void> {
    try {
      await typeOtpIntoBankPage(this.input.zomato, otp, ZPAYKIT_ORIGIN);
    } catch (err) {
      const shape = (err as { shape?: OtpPageShape }).shape;
      if (shape) this.otpPageShape = shape;
      throw err;
    }
  }

  // What became of the order, asked of the vendor's own list.
  //
  // Matched by the CART, not by the payment's order id. Measured on a real
  // payment: the settle answered 1000000002, the vendor's list calls the same
  // order 1000000003, and the only id tying them together is the cart
  // (Appendix A). Matching on the payment id would find nothing, every time.
  //
  // A just-paid order is a tracking card for some minutes before it is a row
  // in that list, so "not there" is `unknown` and never `paid: false`.
  async outcome(): Promise<{ orderId: string | null; paid: boolean; unknown: boolean }> {
    try {
      const r = await this.input.blinkitCall('/v1/layout/order_history', 'POST', {});
      if (r.status !== 200) return { orderId: this.placedOrderId, paid: false, unknown: true };
      const verdict = verdictForCart(stubsFromList(JSON.parse(r.body)), this.input.cartId);
      if (verdict.state !== 'placed') return { orderId: this.placedOrderId, paid: false, unknown: true };
      // The vendor's own word for the order. Anything it is actively
      // delivering or has delivered is an order that went through; a word we
      // have not seen is not one to guess at, so it stays unknown.
      const word = verdict.order.status.toUpperCase();
      const alive = ['DELIVERED', 'ENROUTE', 'ARRIVING', 'PLACED', 'CONFIRMED', 'PACKING', 'ACTIVE'].includes(word);
      const dead = ['CANCELLED', 'CANCELED', 'FAILED', 'REFUNDED'].includes(word);
      return {
        orderId: verdict.order.orderId,
        paid: alive,
        unknown: !alive && !dead,
      };
    } catch {
      return { orderId: this.placedOrderId, paid: false, unknown: true };
    }
  }

  get gatewayTrackId(): string | null {
    return this.trackId;
  }
}

export const BLINKIT_PAY_PATH = `${ZPAYKIT_ORIGIN}${ZPAYKIT_MAKE_PAYMENT_PATH}`;
export const BLINKIT_CHECKOUT_TIMEOUT_MS = CHECKOUT_SCREEN_TIMEOUT_MS;
