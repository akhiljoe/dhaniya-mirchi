// Browsers that still hold a cart, kept open between the job that filled one
// and the job that pays for it.
//
// Why this exists. Instamart's cart belongs to the ACCOUNT: the worker fills
// it in one job, the browser closes, and the checkout finds it again in the
// next job. Blinkit's belongs to the browser that filled it - not to the
// account, and not to the device, both ruled out by measurement (see
// `BlinkitPageSession.refill`). So paying for a Blinkit cart meant building
// the same cart a second time, and the household waited for the same minute
// twice: once on Send, again on Pay, for items that were never anywhere else.
//
// The cart loop and the pay loop run in one worker process, so the browser
// that filled the cart can simply be the browser that pays for it. It is
// parked here when a cart job ends well, and the pay job asks for it by the
// cart job's id.
//
// What is parked is a live authenticated session to a grocery account with a
// saved card, so it is held on a short leash:
//
//   - it expires on its own, whether or not anyone comes for it;
//   - only a few are ever held at once, oldest closed first;
//   - taking it REMOVES it, so two jobs can never drive one browser;
//   - the worker closes every one of them on shutdown.
//
// Nothing here changes what is paid for: the payment screen is still checked
// against the cart job's own lines before a rupee moves.
import type { Logger } from '../logger.js';
import { LIVE_CART_MAX, LIVE_CART_TTL_MS } from '../constants.js';
import type { CartSession } from './adapters/instamart-cart.js';

interface Parked {
  cartJobId: string;
  householdId: string;
  session: CartSession;
  // How many lines the session actually got into the cart, so the payment
  // screen can be checked against it without reading the cart page again.
  lines: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export class LiveCarts {
  private readonly parked = new Map<string, Parked>();

  constructor(
    private readonly logger: Logger,
    private readonly ttlMs: number = LIVE_CART_TTL_MS,
    private readonly max: number = LIVE_CART_MAX,
  ) {}

  // Keep this browser open for the payment that may follow.
  //
  // The caller must not close the session after calling this: it is this
  // object's to close from here on, whether it is claimed or expires.
  park(cartJobId: string, householdId: string, session: CartSession, lines: number): void {
    // Never two browsers for one cart.
    this.close(cartJobId, 'replaced');
    // Oldest first when there are too many. A household waiting on the cart
    // it just sent matters more than one that walked away ten minutes ago.
    while (this.parked.size >= this.max) {
      const oldest = [...this.parked.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (!oldest) break;
      this.close(oldest.cartJobId, 'too many open');
    }
    const timer = setTimeout(() => this.close(cartJobId, 'expired'), this.ttlMs);
    // A pending timer must not be what keeps the worker alive at shutdown.
    timer.unref?.();
    this.parked.set(cartJobId, { cartJobId, householdId, session, lines, expiresAt: Date.now() + this.ttlMs, timer });
    this.logger.info('cart: browser kept open for payment', { job: cartJobId, lines, forMs: this.ttlMs, open: this.parked.size });
  }

  // The browser holding this cart, if it is still open, and it is the
  // caller's to close from here on.
  //
  // The household is checked, not trusted: a cart job id is not a secret, and
  // one household must never be handed a browser signed in as another.
  take(cartJobId: string | null, householdId: string): { session: CartSession; lines: number } | null {
    if (!cartJobId) return null;
    const held = this.parked.get(cartJobId);
    if (!held) return null;
    if (held.householdId !== householdId) {
      this.logger.warn('cart: a parked browser was asked for by another household', { job: cartJobId });
      return null;
    }
    clearTimeout(held.timer);
    this.parked.delete(cartJobId);
    this.logger.info('cart: paying in the browser that filled the cart', { job: cartJobId, lines: held.lines });
    return { session: held.session, lines: held.lines };
  }

  private close(cartJobId: string, why: string): void {
    const held = this.parked.get(cartJobId);
    if (!held) return;
    clearTimeout(held.timer);
    this.parked.delete(cartJobId);
    this.logger.info('cart: parked browser closed', { job: cartJobId, why });
    void held.session.close().catch(() => {});
  }

  // Every parked browser, on the way down. A headless Chrome that outlives
  // the worker is a signed-in browser nobody is watching.
  async closeAll(): Promise<void> {
    for (const id of [...this.parked.keys()]) this.close(id, 'worker stopping');
  }

  get size(): number {
    return this.parked.size;
  }
}
