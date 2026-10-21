// The dry run for ordering on Blinkit (design §19 stage 2, Appendix A):
// walk the real chain as far as it goes without paying, and say what was
// found.
//
// This is the sister of order.ts, and the differences are the whole point:
//
//   - Instamart creates the order BEFORE the money moves, so its dry run
//     stops one call early. Blinkit does not: `createOrder` hands back a
//     token and an order hash, and the household's order list is unchanged
//     either side of it (measured twice on the real account). So this one CAN
//     walk the whole chain and still owe nobody anything. It stops at the
//     payment hash, which is where money starts.
//   - Blinkit has no read-only look at a cart. `POST /v5/carts` REPLACES, and
//     `GET` on the same path is a 405 (probed 2026-09-22). So a dry run that
//     puts something in the cart has destroyed whatever was there, and this
//     one says so before it does it and empties the cart afterwards.
//   - The cart belongs to a `device_id`, not the account, so the cart filled
//     here is the worker's own and the household's phone never sees it. That
//     is bearable only because this vendor's carts are paid for by us; it is
//     why Blinkit is not in CART_VENDORS.
//
// Nothing here places an order and no money moves.
import type { VaultConfig } from '../config.js';
import type { Db } from '../db.js';
import { ORDER_HARD_CAP_RUPEES } from '../constants.js';
import { errorFields, type Logger } from '../logger.js';
import { openSealed } from '../vault.js';
import { blinkitCartAdapter, type BlinkitCartItem, type BlinkitCartSession } from './adapters/blinkit-cart.js';
import type { VendorAddress } from './adapters/instamart-catalog.js';
import type { CapturedSession } from './connect.js';

export interface BlinkitDryRunDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  open?: (session: CapturedSession, address: VendorAddress) => Promise<BlinkitCartSession>;
}

export interface BlinkitDryRunOptions {
  householdId: string;
  phoneLast4?: string;
  // What to put in the cart, by name. Each is searched and the cheapest thing
  // in stock is taken. Empty means walk nothing: the chain needs something to
  // cost money before the vendor will price it.
  add: string[];
  // Which saved address to use, by its vendor id. There is no default and no
  // guess. This household has 39 saved addresses across four cities, several
  // of them labelled "Home", and two of them were shared to this account from
  // somebody else's - so there is no rule that picks the right one.
  addressId?: string;
}

// Pick the address to fill against.
//
// The household's chosen one wins. Otherwise the caller must name one, and
// when they have not, this lists what there is and refuses - because on this
// vendor the address chooses the STORE, so a wrong guess is not a wrong
// doorstep, it is a different shop with a different catalogue.
export function chooseAddress(
  chosen: VendorAddress | null,
  saved: VendorAddress[],
  wantedId?: string,
): { address: VendorAddress } | { address: null; reason: 'none_saved' | 'not_found' | 'must_choose' } {
  if (wantedId) {
    const found = saved.find((a) => String(a.id) === String(wantedId));
    return found ? { address: found } : { address: null, reason: 'not_found' };
  }
  if (chosen) return { address: chosen };
  if (!saved.length) return { address: null, reason: 'none_saved' };
  return { address: null, reason: 'must_choose' };
}

interface ConnectionRow {
  id: string;
  phone_last4: string;
  session_sealed: string;
  addresses: VendorAddress[] | null;
  cart_address: VendorAddress | null;
}

export async function blinkitDryRun(deps: BlinkitDryRunDeps, opts: BlinkitDryRunOptions): Promise<number> {
  const { db, logger } = deps;
  const { rows } = await db.query<ConnectionRow>(
    `select id, phone_last4, session_sealed, addresses, cart_address
       from vendor_connections
      where household_id = $1 and vendor = 'blinkit' and ($2::text is null or phone_last4 = $2)
      order by created_at`,
    [opts.householdId, opts.phoneLast4 ?? null],
  );
  if (!rows.length) {
    logger.error('blinkit dry run: that household has no connected Blinkit account', { household: opts.householdId });
    return 1;
  }

  let worst = 0;
  for (const conn of rows) {
    logger.info('blinkit dry run: connection', { phoneLast4: conn.phone_last4 });
    const saved = conn.addresses ?? [];
    const picked = chooseAddress(conn.cart_address, saved, opts.addressId);
    if (!picked.address) {
      logger.error('blinkit dry run: no address to fill against', {
        reason: picked.reason,
        // The ids, so the operator can pass one back with --address. Labels
        // and areas only: a full address is not something to print.
        saved: saved.map((a) => `${a.id} [${a.label || 'no label'}] ${a.display.slice(0, 40)}`),
      });
      worst = Math.max(worst, 1);
      continue;
    }
    const address = picked.address;

    const captured = JSON.parse(
      openSealed(deps.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`),
    ) as CapturedSession;
    const open = deps.open ?? ((s: CapturedSession, a: VendorAddress) => blinkitCartAdapter().open(s, a));
    const session = await open(captured, address);
    try {
      const store = await session.store();
      logger.info('blinkit dry run: the store this session points at', {
        address: `${address.id} [${address.label || 'no label'}]`,
        merchantId: store.merchantId,
        lat: store.lat,
        lng: store.lng,
      });
      // A session that has not resolved a merchant is a session whose cart
      // would be filled at whatever store it was last pointed at.
      if (store.merchantId === null) {
        logger.error('blinkit dry run: the page never resolved a store for these coordinates, so nothing was filled');
        worst = Math.max(worst, 1);
        continue;
      }

      if (!opts.add.length) {
        logger.info('blinkit dry run: nothing to add, so the cart was left alone', {
          // Said plainly, because it is the reason this command does not just
          // "look at the cart" by default.
          note: 'this vendor has no read-only look at a cart; filling one replaces it',
        });
        continue;
      }

      const wanted: { item: BlinkitCartItem; quantity: number }[] = [];
      for (const term of opts.add) {
        const found = await session.search(term);
        if (!found.length) {
          logger.warn('blinkit dry run: this store sells nothing by that name', { asked: term });
          worst = Math.max(worst, 1);
          continue;
        }
        // The cheapest in stock. A dry run pays for nothing, but it does fill
        // a real cart, and the cheapest thing is the least to undo.
        const item = found.reduce((a, b) => (b.price < a.price ? b : a));
        logger.info('blinkit dry run: picked', { asked: term, got: item.product_name, pack: item.unit, price: item.price, of: found.length });
        wanted.push({ item, quantity: 1 });
      }
      if (!wanted.length) {
        logger.error('blinkit dry run: nothing could be found to put in the cart');
        worst = Math.max(worst, 1);
        continue;
      }

      const filled = await session.fill(wanted);
      logger.info('blinkit dry run: the cart, as the vendor bills it', {
        ok: filled.ok,
        cartId: filled.cartId,
        lines: filled.lines.map((l) => `${l.quantity} x ${l.name}`),
        subtotal: filled.subtotal,
        delivery: filled.deliveryFee,
        // Not a sum of ours. The items and the total differ by more than the
        // delivery fee, and the difference is never announced.
        toPay: filled.total,
        freeDeliveryAbove: filled.freeDeliveryAbove,
        unavailableUnits: filled.unavailableUnits,
      });
      if (!filled.ok || filled.cartId === null) {
        logger.error('blinkit dry run: the vendor would not take the cart');
        worst = 2;
        continue;
      }
      if (filled.total !== null && filled.total > ORDER_HARD_CAP_RUPEES) {
        // Nothing here can pay, so this is a warning and not a stop. It is
        // still worth saying: the real path would refuse this cart.
        logger.warn('blinkit dry run: this cart is over the cap the api enforces', { toPay: filled.total, cap: ORDER_HARD_CAP_RUPEES });
      }

      const check = await session.validate(filled.cartId, wanted);
      logger.info('blinkit dry run: what the store says about delivering it', {
        ok: check.ok,
        serviceable: check.serviceable,
        cartId: check.cartId,
        addressId: check.addressId,
        toPay: check.cart.total,
      });
      // The cart the vendor is pricing must be the cart we asked for, at the
      // address we asked for. On this vendor the address chooses the store,
      // so a mismatch is a cart in the wrong city, not a cosmetic one.
      if (check.addressId !== null && String(check.addressId) !== String(address.id)) {
        logger.error('blinkit dry run: the vendor bound this cart to a different address', { asked: address.id, bound: check.addressId });
        worst = 2;
        continue;
      }
      if (check.serviceable === false) {
        logger.error('blinkit dry run: the store will not deliver to this address, so the chain stops here');
        worst = Math.max(worst, 1);
        continue;
      }

      const token = await session.createOrder(filled.cartId);
      logger.info('blinkit dry run: as far as it goes', {
        ok: token.ok,
        // Presence only. The token this call returns is a payment credential
        // and is handled like every other vendor secret: never logged.
        gotPaymentToken: token.paymentToken !== null,
        gotOrderHash: token.orderHash !== null,
        expiresAtEpoch: token.expiresAtEpoch,
        // Twice measured as none. If this ever stops being none, an order
        // exists before the money does and every Instamart rule applies here.
        orderPlaced: token.orderId !== null,
        stoppedBefore: 'zomato_payment_hash',
      });
      if (token.orderId !== null) {
        logger.error('blinkit dry run: this call returned an order id, which it never has before - an order may now exist', { orderId: token.orderId });
        worst = 2;
      }
      if (!token.ok) worst = Math.max(worst, 1);
    } catch (err) {
      logger.error('blinkit dry run: crashed', errorFields(err));
      worst = 2;
    } finally {
      // Always, including after a crash: the cart we filled is a real cart on
      // a real account, and leaving milk in it is leaving a mess behind.
      await session
        .empty()
        .then((s) => logger.info('blinkit dry run: cart emptied', { ok: s.ok }))
        .catch((err) => logger.error('blinkit dry run: could not empty the cart - it still has things in it', errorFields(err)));
      await session.close().catch(() => {});
    }
  }
  return worst;
}
