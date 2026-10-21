// "Add ₹12 more and delivery is free." What to put in so the delivery fee
// stops being worth paying, chosen from what the household buys anyway.
//
// The rule that matters here is that this must never cost more than it
// saves. A store nudging somebody to spend ₹150 to avoid a ₹30 fee is the
// store's interest, not the household's, so nothing is suggested that costs
// more than the fee it removes. When nothing the household buys fits that
// window, the app says the gap and suggests nothing at all.
//
// The threshold is never guessed: it comes from the store's own line on the
// cart (`bill.freeDeliveryAbove`). No threshold, no suggestion.
import { TOPUP_PICKS, TOPUP_SPEND_FRACTION } from './constants';

export interface TopUpCandidate {
  id: string;
  name: string;
  emoji: string;
  price: number; // what one costs, from what they last paid
  dueRatio?: number | null; // how overdue it is; the ones they need come first
}

export interface TopUp {
  gap: number; // how much more the cart needs, rounded up to the rupee
  saves: number; // the delivery fee that goes away
  threshold: number;
  picks: TopUpCandidate[]; // each one closes the gap on its own, cheapest first
}

export function topUpForFreeDelivery(opts: {
  subtotal: number;
  threshold: number | null | undefined;
  deliveryFee: number | null | undefined;
  candidates: TopUpCandidate[];
}): TopUp | null {
  const { subtotal, threshold, deliveryFee, candidates } = opts;
  // Nothing to save, or nothing to say: no threshold from the store, no fee
  // being charged, or the cart is already over the line.
  if (!threshold || threshold <= 0 || !deliveryFee || deliveryFee <= 0) return null;
  if (subtotal >= threshold) return null;
  const gap = Math.ceil(threshold - subtotal);

  const picks = candidates
    // Closes the gap by itself, and costs no more than the fee it saves.
    // The second half is the whole point: crossing the line by spending more
    // than the fee is a worse deal than paying the fee.
    .filter((c) => c.price >= gap && c.price <= deliveryFee * TOPUP_SPEND_FRACTION)
    // Cheapest first, then whatever they are most overdue for.
    .sort((a, b) => a.price - b.price || (b.dueRatio ?? 0) - (a.dueRatio ?? 0))
    .slice(0, TOPUP_PICKS);

  return { gap, saves: Math.round(deliveryFee), threshold, picks };
}
