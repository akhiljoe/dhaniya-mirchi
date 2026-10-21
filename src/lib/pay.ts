// Paying for the cart from the app (design §19 stages 2-3). Stage 1 filled
// the household's real cart and left them to pay in the vendor's app; this is
// the step past it.
//
// Two things the pages built on this have to keep saying out loud:
//
//   * A card needs two numbers typed, the CVV and then the bank's OTP. That
//     is the vendor's design, not ours: there is no saved-card path here that
//     skips them.
//   * The vendor creates the order BEFORE the money moves, so "it failed" and
//     "there is an order you have not paid for" are different sentences and
//     the second one has to be shown.
import { api } from './api';
import { cartVendorInfo } from './constants';

export type OrderStatus = 'requested' | 'running' | 'awaiting_ok' | 'awaiting_cvv' | 'paying' | 'awaiting_otp' | 'done' | 'failed';
export type PayMethod = 'card' | 'on_delivery';

export interface OrderJob {
  status: OrderStatus;
  // Which app this order is on. A resumed screen reads it from here rather
  // than assuming.
  vendor: string;
  method: PayMethod;
  cardLabel: string | null;
  // What they agreed to, and what the vendor's own payment screen showed.
  // These differ: the checkout adds fees the cart call never spells out, so
  // the worker stops on `awaiting_ok` and asks about `vendorTotal` rather
  // than paying a number nobody saw.
  agreedTotal: number;
  vendorTotal: number | null;
  // What the bank's own page says it is taking. The one figure here that
  // cannot be stale - the app can change the order between the household
  // agreeing to a price and the bank being asked - so once it exists it is
  // what the screen says. Null when the bank's page does not state one.
  bankTotal: number | null;
  orderId: string | null;
  paid: boolean;
  // An order exists at the vendor and the money did not move.
  unpaidOrder: boolean;
  errorCode: string | null;
}

// `cartJobId`: the cart this is paying for. The worker checks the payment
// screen against it and pays through that cart's own connection.
export function startOrder(vendor: string, method: PayMethod, maxTotal: number, cardLabel?: string, cartJobId?: string): Promise<{ id: string }> {
  return api('POST', '/api/order', { vendor, method, maxTotal, cardLabel, cartJobId });
}

// The CVV or the bank's OTP, on its way to the worker. It is sealed the
// moment it reaches the api and never comes back out (server/src/api/order.ts).
export function sendSecret(id: string, kind: 'cvv' | 'otp', value: string): Promise<void> {
  return api('POST', `/api/order/${encodeURIComponent(id)}/secret`, { kind, value });
}

// Yes to the vendor's own total. Only the exact number the payment screen
// showed is accepted, so this always sends what the app is showing.
export function agreeToTotal(id: string, total: number): Promise<void> {
  return api('POST', `/api/order/${encodeURIComponent(id)}/agree`, { total });
}

// The order this household has on the go, if any. An order must never live
// only in the page that started it: close that page while it is waiting for a
// bank's code and the code can never be given, while the order it belongs to
// is already placed (seen 2026-09-22).
export function liveOrder(): Promise<{ id: string | null }> {
  return api('GET', '/api/order/live');
}

export function getOrder(id: string): Promise<OrderJob> {
  return api('GET', `/api/order/${encodeURIComponent(id)}`);
}

// Only works while nothing has been ordered. After that it has to be
// cancelled in the vendor's own app, and the api says so.
export function cancelOrder(id: string): Promise<void> {
  return api('POST', `/api/order/${encodeURIComponent(id)}/cancel`, {});
}

export const ORDER_WAITING: OrderStatus[] = ['requested', 'running', 'awaiting_ok', 'awaiting_cvv', 'paying', 'awaiting_otp'];
export const isWaiting = (s: OrderStatus): boolean => ORDER_WAITING.includes(s);

// What the household is being asked for right now, if anything.
export function asks(job: OrderJob | null): 'cvv' | 'otp' | null {
  if (job?.status === 'awaiting_cvv') return 'cvv';
  if (job?.status === 'awaiting_otp') return 'otp';
  return null;
}

// What is happening, in words. Each one says what the household should do, or
// that there is nothing to do.
export function orderText(job: OrderJob): string {
  switch (job.status) {
    case 'requested':
    case 'running':
      return 'Opening the payment screen.';
    case 'awaiting_ok':
      return `${cartVendorInfo(job.vendor).name}'s total is ₹${Math.round(job.vendorTotal ?? 0)}, not the ₹${Math.round(job.agreedTotal)} the cart showed.`;
    case 'awaiting_cvv':
      return `Enter the CVV for ${job.cardLabel ?? 'your card'}.`;
    case 'paying':
      return 'Paying now.';
    case 'awaiting_otp':
      return 'Your bank sent a code. Enter it here.';
    case 'done':
      return job.method === 'on_delivery' ? 'Ordered. Pay when it arrives.' : 'Paid. The order is on its way.';
    default:
      return ORDER_ERROR_TEXT[job.errorCode ?? ''] ?? ORDER_ERROR_FALLBACK;
  }
}

export const ORDER_ERROR_TEXT: Record<string, string> = {
  // The cart changed under them between tapping and paying.
  total_changed: 'The price changed, so nothing was ordered. Check the cart and try again.',
  wrong_address: 'That cart is for a different address, so nothing was ordered. Check the address and try again.',
  cart_changed: 'The cart changed since you looked at it, so nothing was ordered. Open the app and check it.',
  card_not_found: 'That card is not on the payment screen any more. Pick another.',
  no_saved_cards: 'The payment screen showed no saved card. Open the app, check a card is saved, then try again.',
  no_cvv_box: 'The payment screen did not ask for a CVV. Nothing was ordered.',
  cvv_not_accepted: 'That CVV did not fit the box for this card. Check the digits and try again.',
  no_pay_button: 'The payment screen changed. Nothing was ordered.',
  no_on_delivery: 'Pay on Delivery is not offered on this order.',
  no_otp_box: "We could not find where to type your bank's code. The order is placed. Open the app to pay for it or cancel it.",
  otp_not_accepted: "Your bank's page did not take the whole code. The order is placed. Open the app to pay for it or cancel it.",
  no_secret: 'Nothing was entered in time.',
  not_agreed: 'The price was not agreed, so nothing was ordered.',
  not_paid: 'The payment did not go through.',
  // Said with the order id when there is one (unpaidWarning names it): the
  // store took the order and we could not read it back. The one thing not to
  // do is pay again.
  unconfirmed: 'Your bank accepted it, but we could not read the order back from the app. Check the app. Do not pay again.',
  empty_cart: 'There is nothing in the cart to pay for.',
  cart_too_small: 'The app will not check out a cart this small. Add a few more things and send it again.',
  no_payment_screen: 'The payment screen did not open. Nothing was ordered.',
  cancelled: 'Stopped. Nothing was ordered.',
  // Stopped with the bank's page up. By then the app has already made the
  // order - it does that before the money moves - so this must never be said
  // as "nothing happened".
  cancelled_after_order: 'Payment stopped. The order was already placed and is not paid for, so check it in the app.',
  interrupted: 'That stopped before anything was ordered.',
  unknown_after_pay: 'We lost track after pressing Pay. Check the app before trying again.',
  unauthorized: 'That app needs connecting again. Open the Grocery apps page.',
  unreachable: "The app didn't answer just now. Please try again.",
  internal: 'Something went wrong. Check the app before trying again.',
};
export const ORDER_ERROR_FALLBACK = 'Something went wrong. Check the app before trying again.';

// Said whenever an order exists that was not paid for. The household has to
// hear this from us, not find it in the app tomorrow.
export function unpaidWarning(job: OrderJob): string | null {
  if (!job.unpaidOrder) return null;
  // Naming it helps them find it; not having the name is no reason to say
  // nothing, because the order is there either way.
  return job.orderId
    ? `Order ${job.orderId} was placed and not paid for. Open the app to pay for it or cancel it.`
    : 'An order was placed and not paid for. Open the app to pay for it or cancel it.';
}
