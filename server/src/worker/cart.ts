// Putting a household's items in its real vendor cart (design §19 Ordering,
// stage 1). In the worker because only the worker can open a household's
// vendor session (§14.3).
//
//   requested ──claim──▶ running ──▶ done    (a result line per item)
//                                 └─▶ failed (unauthorized / unreachable /
//                                             address_needed / not_serving)
//
// The job never guesses: each line says what was wanted, what the cart holds
// now, and why, in the vendor's own terms (out of stock, not listed here).
// Anything actually added is written to prompted_adds, because a purchase the
// app prompted must stay out of the consumption rate (§9.1).
import { CART_MAX_CONCURRENT, CART_STALE_SECONDS, CART_SWEEP_MS, type ConnectableVendor } from '../constants.js';
import type { VaultConfig } from '../config.js';
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';
import { openSealed } from '../vault.js';
import { CartError, type CartSession, type CartWant } from './adapters/instamart-cart.js';
import { pickAddress, type VendorAddress } from './adapters/instamart-catalog.js';
import type { CapturedSession } from './connect.js';
import { startJobLoop, type JobLoop } from './job-loop.js';
import type { LiveCarts } from './live-carts.js';
import { setWithAlternatives } from './adapters/alternatives.js';

export type CartAdapters = Partial<
  Record<ConnectableVendor, { open(session: CapturedSession, deliverTo: VendorAddress | string | null): Promise<CartSession> }>
>;

export interface CartDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  adapters: CartAdapters;
  // Where a browser that has filled a cart waits for the payment that may
  // follow, so a cart this vendor keeps only in the browser is not built
  // twice. Absent in tests and the one-shot commands, which close as before.
  liveCarts?: LiveCarts;
}

// The oldest waiting cart, but never a second one for a household that
// already has one being filled: two at once would fight over the same cart.
// Other households are not held up.
export async function claimNextCartJob(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `update cart_jobs set status = 'running', updated_at = now()
      where id = (
        select j.id from cart_jobs j
         where j.status = 'requested'
           and not exists (select 1 from cart_jobs r where r.household_id = j.household_id and r.status = 'running')
         order by j.created_at
         for update skip locked limit 1)
      returning id`,
  );
  return rows[0]?.id ?? null;
}

// A job left running by a stopped worker: failed, not retried. Part of it may
// already be in the cart, so repeating it blindly could add more.
export async function failStaleCartJobs(db: Db): Promise<void> {
  await db.query(
    `update cart_jobs set status = 'failed', error_code = 'interrupted', updated_at = now()
      where status = 'running' and updated_at < now() - make_interval(secs => $1)`,
    [CART_STALE_SECONDS],
  );
}

// Has the household asked for this one to stop? Read fresh each time: the
// request arrives while the job is already running.
async function cancelAsked(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query<{ asked: Date | null }>('select cancel_requested_at as asked from cart_jobs where id = $1', [id]);
  return !!rows[0]?.asked;
}

async function finish(db: Db, id: string, fields: { status: 'done' | 'failed'; result?: unknown; errorCode?: string }) {
  await db.query('update cart_jobs set status = $2, result = $3, error_code = $4, updated_at = now() where id = $1', [
    id,
    fields.status,
    fields.result === undefined ? null : JSON.stringify(fields.result),
    fields.errorCode ?? null,
  ]);
}

export async function runCartJob(deps: CartDeps, id: string): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<{
    household_id: string;
    connection_id: string;
    vendor: ConnectableVendor;
    wanted: CartWant[];
    session_sealed: string;
    cart_address: VendorAddress | null;
    address_label: string | null;
  }>(
    `select j.household_id, j.connection_id, j.vendor, j.wanted, c.session_sealed, c.cart_address,
            (select o.address_label from raw_orders o
              where o.connection_id = j.connection_id and o.address_label is not null
              order by o.placed_at desc limit 1) as address_label
       from cart_jobs j join vendor_connections c on c.id = j.connection_id
      where j.id = $1`,
    [id],
  );
  const job = rows[0];
  if (!job) return;
  const log = { job: id, vendor: job.vendor, items: job.wanted.length };

  const adapter = deps.adapters[job.vendor];
  if (!adapter) return finish(db, id, { status: 'failed', errorCode: 'unsupported_vendor' });

  let session: CartSession | null = null;
  // Once handed to the registry the browser is no longer this job's to close.
  let parked = false;
  try {
    const captured = JSON.parse(openSealed(deps.vault.privateKeys, job.session_sealed, `vendor_connections:${job.connection_id}:session`)) as CapturedSession;
    const openedAt = Date.now();
    // The address the household chose when it connected the app; before it
    // has chosen, the one its orders go to.
    session = await adapter.open(captured, job.cart_address ?? job.address_label);
    const openMs = Date.now() - openedAt;

    // The app's saved addresses as they are now, so the household can pick
    // where its cart is filled (design §19 stage 1); and if it has not picked
    // yet, the one its orders go to.
    const saved = await session.addresses().catch(() => [] as VendorAddress[]);
    if (saved.length) {
      // A guess until the household says so: matched from the address its
      // orders go to. The page shows it as a guess and asks.
      const guess = pickAddress(saved, job.address_label);
      const chosen = job.cart_address ?? (guess && { ...guess, chosenByHousehold: false });
      await db.query('update vendor_connections set addresses = $2, cart_address = coalesce(cart_address, $3) where id = $1', [
        job.connection_id,
        JSON.stringify(saved),
        chosen ? JSON.stringify(chosen) : null,
      ]);
    }

    // Not delivering right now (rain, high demand, closed, out of the area):
    // nothing is put in the cart, and the vendor's own words are shown.
    const before = await session.state();
    if (!before.serving) {
      logger.info('cart: store not serving', { ...log, statuses: before.statuses, message: !!before.message });
      return finish(db, id, { status: 'failed', errorCode: 'not_serving', result: { message: before.message, eta: before.eta } });
    }

    // What the household already had in the cart, before we touched it. The
    // vendor's app keeps its own copy and pushes it up whenever it has one:
    // with anything of the household's in there, opening the app replaces the
    // cart and our items are gone (measured on the real account, 2026-09-21;
    // an empty app cart takes ours instead). We still fill - they may pay
    // without opening the app - but the page must be able to warn rather than
    // let them find out at checkout.
    const theirs = before.lines.reduce((n, l) => n + l.quantity, 0);

    // One thing at a time, checking between each whether the household has
    // asked it to stop. Between items is the only safe place to look: half
    // way through adding one, the vendor's page is mid-flight and stopping
    // there would leave neither us nor them knowing what is in the cart.
    const lines = [];
    let stopped = false;
    for (const want of job.wanted) {
      if (await cancelAsked(db, id)) {
        stopped = true;
        logger.info('cart: stopped on request', { ...log, added: lines.length, of: job.wanted.length });
        break;
      }
      lines.push(await setWithAlternatives(session, want));
    }
    // Nothing went in, so nothing is in the cart to talk about.
    if (stopped && !lines.some((l) => l.inCart > 0)) {
      return finish(db, id, { status: 'failed', errorCode: 'cancelled' });
    }
    const after = await session.state();
    for (const l of lines.filter((x) => x.state === 'added')) {
      await db.query(
        `insert into prompted_adds (household_id, cart_job_id, vendor, item, product, pack, quantity)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [job.household_id, id, job.vendor, l.item, l.product, l.pack, l.inCart],
      );
    }
    // What this store charges for delivery and what it says delivery is free
    // above, kept on the connection. The cart answer is the only place the
    // store states it, and it was being read for this one bill and thrown
    // away - so the app could only ever say "₹12 more and delivery is free"
    // about a cart already filled, never about the list being built.
    // Only written when the store actually said: a null here means it has
    // not, and the app then says nothing rather than remembering a figure
    // that may have stopped being true.
    if (after.bill.freeDeliveryAbove !== null || after.bill.delivery !== null) {
      await db.query(
        `update vendor_connections
            set free_delivery_above = coalesce($2, free_delivery_above),
                delivery_fee = coalesce($3, delivery_fee),
                delivery_terms_at = now()
          where id = $1`,
        [job.connection_id, after.bill.freeDeliveryAbove, after.bill.delivery],
      );
    }
    await finish(db, id, {
      status: 'done',
      result: {
        // Stopped part way, with things already in the cart. It is a real
        // cart and it gets said as one: what went in, and that the rest did
        // not. Calling this "cancelled" would be a lie about a cart the
        // household can go and pay for.
        stopped,
        lines,
        bill: after.bill,
        eta: after.eta,
        cartLines: after.lines.length,
        // And the store's count of UNITS, which is what Instamart's payment
        // screen says ("9 items" for paneer x2, carrot x5, cheese x1, cheese x1).
        // Compared against lines it was apples and oranges, and stopped a paid
        // payment on 2026-09-23.
        cartUnits: after.lines.reduce((n, l) => n + l.quantity, 0),
        // The store's whole cart, by name, so the page can show what was
        // already in it apart from what this job put in. A count alone left a
        // bill of Rs 942 under one Rs 260 line, and it read as a wrong price.
        cart: after.lines.map((l) => ({ name: l.name, quantity: l.quantity })),
        theirsBefore: theirs,
        address: session.address?.label ?? job.address_label,
      },
    });
    // The browser that just filled this cart is the only place that cart
    // exists on this vendor, so it waits for the Pay the household is being
    // shown right now rather than being thrown away and rebuilt.
    const inCart = lines.filter((l) => l.inCart > 0).length;
    if (deps.liveCarts && session.refill && inCart > 0 && !stopped) {
      deps.liveCarts.park(id, job.household_id, session, inCart);
      parked = true;
    }
    logger.info('cart: filled', {
      ...log,
      added: lines.filter((l) => l.state === 'added').length,
      failed: lines.filter((l) => l.state === 'failed').length,
      openMs,
      address: session.address?.label ?? null,
      ...(session.timings ?? {}),
    });
  } catch (err) {
    const code = err instanceof CartError ? err.code : 'internal';
    if (!(err instanceof CartError)) logger.error('cart: job crashed', { ...log, ...errorFields(err) });
    else logger.info('cart: job failed', { ...log, reason: code }); // not "code": the logger guards that name
    if (code === 'unauthorized') {
      await db.query(`update vendor_connections set status = 'needs_reconnect' where id = $1`, [job.connection_id]);
    }
    await finish(db, id, { status: 'failed', errorCode: code });
  } finally {
    if (parked) session = null;
    await session?.close().catch(() => {});
  }
}

// What the worker sees in a household's vendor cart, read-only: the lines,
// the store's own delivery state, and which address the cart is for. For
// checking "it isn't in my app" without touching anything.
export async function describeCart(deps: CartDeps, householdId: string): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<{ id: string; vendor: ConnectableVendor; session_sealed: string; phone_last4: string; address_label: string | null }>(
    `select c.id, c.vendor, c.session_sealed, c.phone_last4,
            (select o.address_label from raw_orders o where o.connection_id = c.id and o.address_label is not null order by o.placed_at desc limit 1) as address_label
       from vendor_connections c where c.household_id = $1 order by c.created_at`,
    [householdId],
  );
  if (!rows.length) throw new Error('that household has no connected app');
  for (const conn of rows) {
    const adapter = deps.adapters[conn.vendor];
    if (!adapter) continue;
    logger.info('cart: connection', { vendor: conn.vendor, phoneLast4: conn.phone_last4, address: conn.address_label });
    const captured = JSON.parse(openSealed(deps.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
    const session = await adapter.open(captured, conn.address_label);
    try {
      const saved = await session.addresses();
      logger.info('cart: addresses saved in the app', {
        count: saved.length,
        labels: saved.map((a) => a.label || '(no label)'),
        answer: session.addressAnswer,
        chosen: session.address?.label ?? null,
      });
      const state = await session.state();
      logger.info('cart: as the worker sees it', {
        serving: state.serving,
        eta: state.eta,
        statuses: state.statuses,
        toPay: state.bill.toPay,
        delivery: state.bill.delivery,
        freeDeliveryAbove: state.bill.freeDeliveryAbove,
        lines: state.lines.map((l) => `${l.quantity} × ${l.name} (${l.sku})`),
      });
      // What this account could pay with, and which of those need somebody
      // there (design §19 stage 2). Read-only: asking the checkout what it
      // offers places nothing and pays nothing.
      const pay = await session.paymentOptions();
      logger.info('cart: how this account can pay', {
        offers: pay.map((o) => o.label),
        withoutAPerson: pay.filter((o) => !o.needsPerson).map((o) => o.label),
      });
    } finally {
      await session.close().catch(() => {});
    }
  }
}

export function startCartLoop(deps: CartDeps, databaseUrl: string): Promise<JobLoop> {
  return startJobLoop({
    name: 'cart',
    channel: 'cart_jobs',
    databaseUrl,
    logger: deps.logger,
    sweepMs: CART_SWEEP_MS,
    maxConcurrent: CART_MAX_CONCURRENT,
    beforeSweep: () => failStaleCartJobs(deps.db),
    claim: () => claimNextCartJob(deps.db),
    run: (id) => runCartJob(deps, id),
  });
}
