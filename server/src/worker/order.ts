// The dry run for ordering (design §19 stage 2): walk the household's real
// checkout as far as it can be walked without buying anything, and say what
// was found.
//
// It ends deliberately one step short. The recorded checkout (design §19)
// showed that POST /api/v3/instamart/checkout/order creates the order BEFORE
// any money moves - it answers `status: PLACED` with `payment_status:
// PENDING` - so calling it and then stopping would leave the household with a
// real, unpaid order. This command never calls it. Nothing here places an
// order and no money moves.
//
// What it is for: proving the chain the app will drive, and reading what the
// account can actually pay with. Both the cart and the payment question are
// signed by the vendor's own page, so neither can be asked with our own fetch
// (probed 2026-09-21) - they are driven through, and overheard from, the page.
import type { ConnectableVendor } from '../constants.js';
import type { VaultConfig } from '../config.js';
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';
import { openSealed } from '../vault.js';
import { CartError, type CartWant } from './adapters/instamart-cart.js';
import type { VendorAddress } from './adapters/instamart-catalog.js';
import type { CartAdapters } from './cart.js';
import type { CapturedSession } from './connect.js';

export interface DryRunDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  adapters: CartAdapters;
}

export interface DryRunOptions {
  householdId: string;
  phoneLast4?: string;
  // Something to put in the cart first, when it is empty: the page only asks
  // what the account can pay with once there is something to pay for.
  add?: string;
}

export async function orderDryRun(deps: DryRunDeps, opts: DryRunOptions): Promise<number> {
  const { db, logger } = deps;
  const { rows } = await db.query<{
    id: string;
    vendor: ConnectableVendor;
    session_sealed: string;
    phone_last4: string;
    cart_address: VendorAddress | null;
    address_label: string | null;
  }>(
    `select c.id, c.vendor, c.session_sealed, c.phone_last4, c.cart_address,
            (select o.address_label from raw_orders o where o.connection_id = c.id and o.address_label is not null order by o.placed_at desc limit 1) as address_label
       from vendor_connections c
      where c.household_id = $1 and ($2::text is null or c.phone_last4 = $2)
      order by c.created_at`,
    [opts.householdId, opts.phoneLast4 ?? null],
  );
  if (!rows.length) {
    logger.error('dry run: that household has no connected app', { household: opts.householdId });
    return 1;
  }

  let worst = 0;
  for (const conn of rows) {
    const adapter = deps.adapters[conn.vendor];
    if (!adapter) continue;
    logger.info('dry run: connection', { vendor: conn.vendor, phoneLast4: conn.phone_last4 });
    const captured = JSON.parse(openSealed(deps.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
    const session = await adapter.open(captured, conn.cart_address ?? conn.address_label);
    try {
      const before = await session.state();
      logger.info('dry run: the cart as it stands', {
        address: session.address?.label ?? conn.address_label,
        serving: before.serving,
        eta: before.eta,
        toPay: before.bill.toPay,
        lines: before.lines.map((l) => `${l.quantity} x ${l.name}`),
      });
      if (!before.serving) {
        logger.info('dry run: the store is not serving this address, so there is nothing to walk', { message: before.message });
        worst = Math.max(worst, 1);
        continue;
      }

      // Only when asked, and only one: the page needs something to pay for
      // before it will say how the household could pay.
      if (opts.add && !before.lines.length) {
        const want: CartWant = { item: opts.add, product: opts.add, pack: '', qty: 1, match: 'search' };
        const line = await session.set(want);
        logger.info('dry run: put one thing in the cart', { asked: opts.add, got: line.product, pack: line.pack, state: line.state, inCart: line.inCart });
      }

      // The saved cards, so the app can ask which one rather than guess. The
      // dry run is often the first time a household's payment screen is seen.
      const checkout = session.checkout?.();
      if (checkout) {
        const screen = await checkout.open().catch(() => null);
        if (screen) {
          await db.query('update vendor_connections set cards = $2 where id = $1', [conn.id, JSON.stringify(screen.cards)]);
          logger.info('dry run: the payment screen', { total: screen.total, address: screen.address, cards: screen.cards, onDelivery: screen.onDelivery });
        }
      }

      const after = await session.state();
      const options = await session.paymentOptions();
      const withoutAPerson = options.filter((o) => !o.needsPerson);
      logger.info('dry run: how this account can pay', {
        offers: options.map((o) => o.label),
        withoutAPerson: withoutAPerson.map((o) => o.label),
        // Empty is "the page did not tell us", never "there is no way to
        // pay": it asks only when the cart has something in it.
        read: options.length > 0,
      });
      logger.info('dry run: as far as it goes', {
        toPay: after.bill.toPay,
        lines: after.lines.length,
        // The next call in the vendor's chain would create the order before
        // any money moved, so this is where it stops.
        stoppedBefore: 'checkout/order',
        couldOrderUnattended: withoutAPerson.length > 0,
      });
      if (!options.length) worst = Math.max(worst, 1);
    } catch (err) {
      const code = err instanceof CartError ? err.code : 'internal';
      if (err instanceof CartError) logger.info('dry run: stopped', { reason: code });
      else logger.error('dry run: crashed', errorFields(err));
      worst = 2;
    } finally {
      await session.close().catch(() => {});
    }
  }
  return worst;
}
