// What a vendor's payment screen has to be able to do (design §19 stages 2-3).
//
// This exists so `pay.ts` is written once. Every rule that matters lives in
// that one loop - the hard cap, the total the household agreed to, the
// refusal to retry once Pay has been pressed, recording an order id the
// moment it is seen, and asking the vendor afterwards rather than trusting
// the call that placed the order - and a second vendor must inherit all of
// them rather than grow its own copy that is subtly different.
//
// The two vendors could hardly be less alike underneath. Instamart signs its
// own page's requests, so its checkout is driven by clicking the vendor's own
// buttons. Blinkit accepts our fetch, and its payment is not even Blinkit's:
// it is Zomato's zpaykit on another origin, with Razorpay behind it. Both
// still answer these same questions, which is the whole point.
import type { PaymentScreen, PayResult } from './instamart-checkout.js';

export type { PaymentScreen, PayResult };

export interface Checkout {
  // An order id the moment one exists, whether or not the payment worked.
  // This is the difference between telling a household "an order was placed
  // and not paid for" and telling them "it failed".
  readonly placedOrderId: string | null;

  // The shapes that were on the bank's page when no box for the code could be
  // found. Shapes only, never a value: this is the one surface nobody here
  // controls and the only way to learn what it did.
  otpPageShape: { type: string | null; maxLength: number; visible: boolean; named: boolean }[];

  // What is about to be charged, in the vendor's own numbers. The total here
  // is the one the household is asked to agree to, and it is never a sum of
  // ours: on both vendors the cart's bill is lower than the checkout's.
  open(): Promise<PaymentScreen>;

  // The card the household named, by the words their own screen shows.
  chooseCard(label: string): Promise<void>;

  // Whether this card wants its code. Asked rather than assumed: a household
  // told to type a CVV into a screen that never wanted one waits, types, and
  // watches it fail for no reason they can see.
  cvvNeeded(): Promise<boolean>;

  // Spend the money. From here an order may exist whatever happens next.
  pay(cvv: string | null): Promise<PayResult>;

  // The one method that needs nobody. A vendor without it throws.
  payOnDelivery(): Promise<PayResult>;

  // The bank's own code, typed into the bank's own page.
  submitOtp(otp: string): Promise<void>;

  // The household changed its mind with the bank's page up.
  //
  // By then the vendor has made a real order, so there is no undoing - only
  // getting out of the payment the way a person would, by pressing the way
  // out that screen offers. Returns whether one was found and taken. Never
  // throws: the household has already said stop, and a failure to find a
  // button is not a reason to keep them waiting.
  //
  // Optional: a vendor driven through its api rather than a page has no such
  // screen to press.
  cancelPayment?(): Promise<boolean>;

  // What became of the order, asked of the vendor rather than inferred from
  // the call that placed it. `unknown` is its own answer and must never be
  // reported as a failure: that is how a household pays twice.
  outcome(): Promise<{ orderId: string | null; paid: boolean; unknown: boolean }>;
}
