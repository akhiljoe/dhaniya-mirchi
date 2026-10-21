// Paying for a household's cart (design §19 stages 2-3), in the worker
// because only the worker can open a household's vendor session (§14.3).
//
//   requested ─claim─▶ running ─┬─(on delivery)──────────────▶ paying ─▶ done
//                               └─(card)─▶ awaiting_cvv ─▶ paying ─┬─▶ done
//                                                                  └─▶ awaiting_otp ─▶ done
//
// Everything that can refuse an order happens while `running`, before any
// button that spends money: the total is re-read from the vendor's own screen
// and checked against what the household agreed to, the address is checked
// against the one they chose, and the card is found by the name their screen
// shows. Only once all of that passes is Pay pressed.
//
// After Pay, the rules change, because the vendor creates the order BEFORE
// the money moves. From that moment:
//
//   * the job is never retried - a retry would be a second order;
//   * `pay_pressed_at` and any order id are written even when the payment
//     then fails, so "an order exists and was not paid for" can be shown
//     rather than guessed at.
//
// The CVV and the OTP are sealed by the api the moment they arrive (§7.10,
// api/order.ts), opened here, and dropped the moment they have been typed.
// Neither is ever logged, written back, or put in an error message.
import {
  CHECKOUT_SECRET_MAX_AGE_MS,
  CHECKOUT_SECRET_POLL_MS,
  CHECKOUT_SECRET_WAIT_MS,
  ORDER_HARD_CAP_RUPEES,
  ORDER_MAX_CONCURRENT,
  ORDER_STALE_SECONDS,
  ORDER_SWEEP_MS,
  type ConnectableVendor,
} from '../constants.js';
import type { VaultConfig } from '../config.js';
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';
import { openSealed } from '../vault.js';
import { CartError, type CartErrorCode, type CartSession, type CartWant } from './adapters/instamart-cart.js';
import type { PayResult } from './adapters/instamart-checkout.js';
import type { Checkout } from './adapters/checkout.js';
import type { VendorAddress } from './adapters/instamart-catalog.js';
import type { CartAdapters } from './cart.js';
import type { CapturedSession } from './connect.js';
import { startJobLoop, type JobLoop } from './job-loop.js';
import type { LiveCarts } from './live-carts.js';
import { queueImport } from './import/import.js';

export interface PayDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  adapters: CartAdapters;
  // The browsers still holding a cart. A payment for one of them is driven in
  // that browser rather than in a new one.
  liveCarts?: LiveCarts;
  // How long the household gets to type a number. Only a test shortens it.
  secretWaitMs?: number;
}

type OrderStatus = 'requested' | 'running' | 'awaiting_ok' | 'awaiting_cvv' | 'paying' | 'awaiting_otp' | 'done' | 'failed';

interface OrderJob {
  id: string;
  household_id: string;
  connection_id: string;
  vendor: ConnectableVendor;
  method: 'card' | 'on_delivery';
  card_label: string | null;
  max_total: string;
  cart_lines: number | null;
  cart_job_id: string | null;
  agreed_total: string | null;
  session_sealed: string;
  cart_address: VendorAddress | null;
}

// The oldest waiting order. The table already allows only one live job per
// household; this takes them one at a time across all households too, because
// each one drives a browser and asks a person for a number.
export async function claimNextOrderJob(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `update order_jobs set status = 'running', updated_at = now()
      where id = (select id from order_jobs where status = 'requested' order by created_at for update skip locked limit 1)
      returning id`,
  );
  return rows[0]?.id ?? null;
}

// A job left behind by a stopped worker. Never retried, and what happens to
// it depends on whether Pay had been pressed: before, nothing was ordered and
// it is simply abandoned; after, an order may exist and the household is told
// exactly that rather than told it failed.
export async function failStaleOrderJobs(db: Db): Promise<void> {
  await db.query(
    `update order_jobs
        set status = 'failed',
            error_code = case when pay_pressed_at is null then 'interrupted' else 'unknown_after_pay' end,
            secret_sealed = null,
            secret_kind = null,
            updated_at = now()
      where status in ('running', 'awaiting_ok', 'awaiting_cvv', 'paying', 'awaiting_otp')
        and updated_at < now() - make_interval(secs => $1)`,
    [ORDER_STALE_SECONDS],
  );
}

async function setStatus(db: Db, id: string, status: OrderStatus, fields: Record<string, unknown> = {}): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()'];
  const args: unknown[] = [id, status];
  for (const [k, v] of Object.entries(fields)) {
    args.push(v);
    sets.push(`${k} = $${args.length}`);
  }
  await db.query(`update order_jobs set ${sets.join(', ')} where id = $1`, args);
}

// Waits for the household to send the number, opens it, and clears the row in
// the same breath so it can never be used twice. Returns null when they never
// sent it, or sent it so long ago that it has expired.
//
// The value returned is held by the caller only until it is typed.
export async function waitForSecret(
  deps: PayDeps,
  id: string,
  kind: 'cvv' | 'otp',
  waitMs = CHECKOUT_SECRET_WAIT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string | 'cancelled' | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    // Asked to stop. Checked on every turn of this loop, because this is the
    // only place the job waits long enough for a household to change its
    // mind, and by now there is an order at the vendor to get out of.
    const { rows: stop } = await deps.db.query<{ cancel_requested: boolean }>('select cancel_requested from order_jobs where id = $1', [id]);
    if (stop[0]?.cancel_requested) return 'cancelled';
    // Read and clear in one statement, so a secret can never be taken twice:
    // the update's own row lock serialises anyone else trying, and this job
    // is the only reader anyway (one live order per household).
    //
    // The reading is done in the CTE on purpose. `returning` hands back the
    // row as it is AFTER the update, which here is the null just written -
    // the first version of this read its own erasure and never saw a CVV at
    // all, and the tests below are what caught it.
    const { rows } = await deps.db.query<{ secret_sealed: string | null; secret_at: Date | null }>(
      `with held as (
         select id, secret_sealed, secret_at from order_jobs
          where id = $1 and secret_kind = $2 and secret_sealed is not null
       )
       update order_jobs o
          set secret_sealed = null, secret_kind = null, updated_at = now()
         from held
        where o.id = held.id
       returning held.secret_sealed, held.secret_at`,
      [id, kind],
    );
    const row = rows[0];
    if (row?.secret_sealed) {
      // Sent too long ago to be worth typing: an OTP that old has expired,
      // and a household that has walked away should not have an order go
      // through on a number they sent and forgot.
      if (row.secret_at && Date.now() - row.secret_at.getTime() > CHECKOUT_SECRET_MAX_AGE_MS) return null;
      return openSealed(deps.vault.privateKeys, row.secret_sealed, `order_jobs:${id}:${kind}`);
    }
    await sleep(CHECKOUT_SECRET_POLL_MS);
  }
  return null;
}

// Waits for the household to say yes to the vendor's own total. Only that
// exact number counts: the api writes `agreed_total` only when it matches
// what the screen showed, and this checks it again, so a stale tap on an
// older price can never agree to a newer one.
export async function waitForAgreement(
  deps: PayDeps,
  id: string,
  total: number,
  waitMs = deps.secretWaitMs ?? CHECKOUT_SECRET_WAIT_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const { rows } = await deps.db.query<{ agreed_total: string | null; status: string }>('select agreed_total, status from order_jobs where id = $1', [id]);
    const row = rows[0];
    if (!row || row.status === 'failed') return null; // stopped from the app
    if (row.agreed_total !== null && Number(row.agreed_total) === total) return total;
    await sleep(CHECKOUT_SECRET_POLL_MS);
  }
  return null;
}

// Everything that has to be true before a button that spends money is
// pressed. Any one of them failing stops the order, and nothing has been
// ordered at this point, so stopping costs nothing.
export function checkBeforePaying(
  screen: { total: number | null; address: string | null; items?: number | null },
  job: { maxTotal: number; address: string | null; lines?: number | null; agreed?: number | null },
): CartErrorCode | null {
  // A total we cannot read is not a total we may pay. This is the number the
  // household's cap is checked against (design §9.3: never a guess).
  if (screen.total === null) return 'total_changed';
  if (screen.total > job.maxTotal) return 'total_changed';
  if (screen.total > ORDER_HARD_CAP_RUPEES) return 'total_changed';
  // The cart the household saw belongs to one address. If the screen is about
  // to send it somewhere else, that is not the order they agreed to.
  if (job.address && screen.address && screen.address.trim() !== job.address.trim()) return 'wrong_address';
  // The cart the household looked at, and the cart about to be charged for.
  // The vendor's own app pushes its cart up whenever it has one, so between
  // Send and Pay the contents can change under them. Only compared when both
  // are known: a count we do not have is not evidence of a change.
  //
  // And not compared at all once the household has agreed to THIS screen's
  // figure. The count is a proxy for "is this the cart they meant"; a total
  // they read off this screen and said yes to is the thing itself. Live,
  // 2026-09-23: three things sent, cheese sent after, the household agreed
  // to the screen's Rs 608 - and the order was refused because the store's
  // cart had nine lines where the first send had counted three.
  // "Agreed" is either the figure they said yes to when the screen asked, or
  // the figure on the Pay button they tapped: both are the household reading
  // a number and choosing it.
  const said = job.agreed ?? job.maxTotal;
  const agreedThisScreen = screen.total === said;
  if (!agreedThisScreen && job.lines && screen.items && screen.items !== job.lines) return 'cart_changed';
  return null;
}

// The longest an order may take before the payment screen is reached.
//
// A hung job is worse than a failed one: the table allows a household only
// one live order, so a job that never ends blocks every order after it. This
// one hung on a vendor whose cart was not there, and had to be released by
// hand.
const REACH_SCREEN_MS = 4 * 60 * 1000;

async function withDeadline<T>(what: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      what,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CartError('unreachable')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runOrderJob(deps: PayDeps, id: string): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<OrderJob>(
    `select j.id, j.household_id, j.connection_id, j.vendor, j.method, j.card_label, j.max_total, j.agreed_total, j.cart_lines,
            j.cart_job_id, c.session_sealed, c.cart_address
       from order_jobs j join vendor_connections c on c.id = j.connection_id
      where j.id = $1`,
    [id],
  );
  const job = rows[0];
  if (!job) return;
  const log = { job: id, vendor: job.vendor, method: job.method };

  const adapter = deps.adapters[job.vendor];
  if (!adapter) {
    await setStatus(db, id, 'failed', { error_code: 'unsupported_vendor' });
    return;
  }

  let session: CartSession | null = null;
  let checkout: Checkout | null = null;
  try {
    // The browser that filled this cart, if it is still open. On this vendor
    // the cart exists nowhere else, so this is not a shortcut - it is the
    // difference between paying in seconds and building the same cart a
    // second time while the household watches (design §19 stages 1-2).
    const live = deps.liveCarts?.take(job.cart_job_id, job.household_id) ?? null;
    if (live) {
      session = live.session;
    } else {
      const captured = JSON.parse(openSealed(deps.vault.privateKeys, job.session_sealed, `vendor_connections:${job.connection_id}:session`)) as CapturedSession;
      logger.info('pay: opening the app', log);
      session = await adapter.open(captured, job.cart_address ?? null);
    }

    // A cart that could not travel is rebuilt here, in this browser, from
    // what the cart job wrote down. Only some vendors need it (see
    // CartSession.refill), and it is skipped outright when this IS the
    // browser that filled it - there is nothing to rebuild. It happens before
    // anything is read off the payment screen, so the screen is asked about
    // the right cart.
    if (!live && session.refill && job.cart_job_id) {
      const { rows: carts } = await db.query<{ wanted: CartWant[] }>('select wanted from cart_jobs where id = $1 and household_id = $2', [
        job.cart_job_id,
        job.household_id,
      ]);
      const wanted = carts[0]?.wanted ?? [];
      if (wanted.length) {
        const back = await session.refill(wanted);
        const got = back.filter((l) => l.inCart > 0).length;
        logger.info('pay: the cart this browser will pay for', { ...log, asked: wanted.length, got });
        // Nothing went back in: there is nothing to pay for, and saying so is
        // better than letting the checkout say it in its own words.
        if (!got) throw new CartError('empty_cart');
      }
    }

    checkout = session.checkout?.() ?? null;
    if (!checkout) throw new CartError('internal');

    const screen = await withDeadline(checkout.open(), REACH_SCREEN_MS);
    logger.info('pay: the payment screen', {
      ...log,
      total: screen.total,
      address: screen.address,
      items: screen.items,
      cards: screen.cards.length,
      onDelivery: screen.onDelivery,
    });
    await setStatus(db, id, 'running', { vendor_total: screen.total });
    // What this account can pay with, kept so the app can offer a choice next
    // time instead of asking for a card it cannot name.
    await db.query('update vendor_connections set cards = $2 where id = $1', [job.connection_id, JSON.stringify(screen.cards)]);

    const address = job.cart_address?.label ?? null;
    let allowed = Number(job.agreed_total ?? job.max_total);
    let stop = checkBeforePaying(screen, {
      maxTotal: allowed,
      address,
      lines: job.cart_lines,
      agreed: job.agreed_total === null ? null : Number(job.agreed_total),
    });

    // The cart's bill is not what the checkout charges: the vendor adds fees
    // neither we nor its own cart call spell out (the cart said 130, the
    // screen said 147, 2026-09-22). So a total that is only higher than the
    // cart said is not a refusal, it is a question - asked with the vendor's
    // own number, and answered before anything is ordered. A total that
    // cannot be read, or one above the hard cap, is still a refusal: neither
    // of those is something to ask a household about.
    if (stop === 'total_changed' && screen.total !== null && screen.total <= ORDER_HARD_CAP_RUPEES) {
      await setStatus(db, id, 'awaiting_ok');
      logger.info('pay: asking about the price', { ...log, screen: screen.total, agreedAtCart: allowed });
      const agreed = await waitForAgreement(deps, id, screen.total);
      if (!agreed) {
        logger.info('pay: the price was not agreed, so nothing was ordered', log);
        await setStatus(db, id, 'failed', { error_code: 'not_agreed' });
        return;
      }
      allowed = agreed;
      stop = checkBeforePaying(screen, { maxTotal: allowed, address, lines: job.cart_lines, agreed });
    }

    if (stop) {
      // What it saw against what it expected, on every one of the three
      // things it can stop for. "cart_changed" with neither count in the log
      // left nothing to tell a real change from a miscount (2026-09-22).
      logger.info('pay: stopped before paying', {
        ...log,
        reason: stop,
        total: screen.total,
        agreed: allowed,
        screenItems: screen.items,
        cartLines: job.cart_lines,
        screenAddress: screen.address,
        cartAddress: address,
      });
      await setStatus(db, id, 'failed', { error_code: stop });
      return;
    }

    let paid: PayResult;
    if (job.method === 'on_delivery') {
      await setStatus(db, id, 'paying');
      paid = await checkout.payOnDelivery();
    } else {
      // No card named means "the one you have". Taken only when the screen
      // shows exactly one, and refused when there is a choice: guessing which
      // of two cards to charge is not a decision to make for a household.
      // The label is written back so the screen can say which card it was.
      const label = job.card_label ?? (screen.cards.length === 1 ? screen.cards[0] : null);
      // No cards at all is not "your card is gone": the screen never offered
      // any. Said apart, because the two are fixed differently - one is
      // choosing again, the other is the screen not being ready or the
      // account having nothing saved.
      if (!screen.cards.length) throw new CartError('no_saved_cards');
      if (!label) throw new CartError('card_not_found');
      if (!job.card_label) await db.query('update order_jobs set card_label = $2 where id = $1', [id, label]);
      await checkout.chooseCard(label);

      // Ask only for what the screen actually asks for. A household told to
      // type a CVV into a screen that never wanted one waits, types, and
      // watches it fail for no reason they can see.
      let cvv: string | null = null;
      if (await checkout.cvvNeeded()) {
        // Nothing has been ordered yet, so waiting here is free and giving up
        // here costs nothing.
        await setStatus(db, id, 'awaiting_cvv');
        const sent = await waitForSecret(deps, id, 'cvv', deps.secretWaitMs);
        // Stopped before anything was ordered, which is the cheap place to
        // stop: nothing exists at the vendor and there is nothing to undo.
        if (sent === 'cancelled') {
          logger.info('pay: stopped before anything was ordered', log);
          await setStatus(db, id, 'failed', { error_code: 'cancelled' });
          return;
        }
        cvv = sent;
        if (!cvv) {
          logger.info('pay: no CVV came, so nothing was ordered', log);
          await setStatus(db, id, 'failed', { error_code: 'no_secret' });
          return;
        }
      } else {
        logger.info('pay: this card was not asked for a CVV', log);
      }
      await setStatus(db, id, 'paying');
      // From here an order may exist whatever happens next.
      paid = await checkout.pay(cvv);
    }

    await setStatus(db, id, 'paying', {
      pay_pressed_at: paid.pressedAt,
      vendor_order_id: paid.orderId,
      paid: paid.paid,
    });
    logger.info('pay: pressed', { ...log, order: paid.orderId, paid: paid.paid, bankAsked: paid.bankAsked, bankTotal: paid.bankTotal });

    if (paid.bankAsked) {
      // The bank's own figure, kept so the household sees what they are
      // actually being charged rather than what the checkout said a minute
      // ago. Nothing is refused on it: the order exists by now and the money
      // is the bank's to ask for - but they type the code knowing the number.
      await setStatus(db, id, 'awaiting_otp', paid.bankTotal === null ? {} : { bank_total: paid.bankTotal });
      const otp = await waitForSecret(deps, id, 'otp', deps.secretWaitMs);
      // Stopped with the bank's page up. The order is already made, so this
      // is not "nothing happened": the vendor's own way out of the payment is
      // taken, exactly as a person pressing Cancel on that screen would, and
      // then the household is told an order exists that was not paid for.
      if (otp === 'cancelled') {
        const left = await checkout.cancelPayment?.().catch(() => false);
        logger.info('pay: stopped at the bank page, after an order was made', { ...log, order: checkout.placedOrderId, tookTheWayOut: !!left });
        await setStatus(db, id, 'failed', { error_code: 'cancelled_after_order', vendor_order_id: checkout.placedOrderId });
        return;
      }
      if (!otp) {
        // The order exists. Saying "failed" without saying that would leave
        // the household with an unpaid order and no idea it was there.
        logger.info('pay: no OTP came, and an order is already placed', { ...log, order: checkout.placedOrderId });
        await setStatus(db, id, 'failed', { error_code: 'no_secret', vendor_order_id: checkout.placedOrderId });
        return;
      }
      try {
        await checkout.submitOtp(otp);
      } catch (err) {
        // The bank's page is the one thing here nobody controls. What it
        // looked like is worth more than the failure alone, and the order it
        // belongs to is already placed.
        if (err instanceof CartError && err.code === 'no_otp_box') logger.info('pay: no box for the code on the bank page', { ...log, boxes: checkout.otpPageShape });
        throw err;
      }
    }

    // What the vendor says became of the order, asked of the vendor rather
    // than inferred from the call that placed it.
    const out = await checkout.outcome();
    await setStatus(db, id, out.paid ? 'done' : 'failed', {
      vendor_order_id: out.orderId ?? checkout.placedOrderId,
      paid: out.paid,
      // "We cannot tell" is its own answer. Calling it a failure would send a
      // household to pay a second time for an order that already went
      // through (design §9.4).
      error_code: out.paid ? null : out.unknown ? 'unconfirmed' : 'not_paid',
    });
    // What was paid for, as the vendor billed it. Never an address and never
    // a card detail (design §7.6).
    await db.query('update order_jobs set result = $2 where id = $1', [
      id,
      JSON.stringify({ total: screen.total, items: screen.items, method: job.method, card: job.card_label }),
    ]);
    logger.info('pay: finished', { ...log, order: out.orderId, paid: out.paid, unknown: out.unknown });
  } catch (err) {
    const code = err instanceof CartError ? err.code : 'internal';
    if (!(err instanceof CartError)) logger.error('pay: job crashed', { ...log, ...errorFields(err) });
    else logger.info('pay: job failed', { ...log, reason: code });
    // Whatever went wrong, if an order was created it is recorded. This is
    // the difference between a household knowing and not knowing.
    await setStatus(db, id, 'failed', { error_code: code, vendor_order_id: checkout?.placedOrderId ?? null });
    if (code === 'unauthorized') await db.query(`update vendor_connections set status = 'needs_reconnect' where id = $1`, [job.connection_id]);
  } finally {
    // Belt and braces: a secret that was never read is not left in the row.
    await db.query('update order_jobs set secret_sealed = null, secret_kind = null where id = $1', [id]).catch(() => {});
    await session?.close().catch(() => {});
    // An order exists at the store - paid, unpaid or unread - so the
    // household's history has a new order in it, and every page built from
    // the orders (History, Insights, what is running low) is out of date
    // until it is read. Rather than wait for the next sweep, this connection
    // is synced now. The import is what turns "we placed it" into "it is in
    // your orders", and it is the only path that may do so (CLAUDE.md: the
    // engine reads the order history, never our own record of a cart).
    if (checkout?.placedOrderId) {
      await queueImport(db, job.connection_id)
        .then(() => logger.info('pay: sync queued for the new order', { ...log, order: checkout?.placedOrderId }))
        .catch((err) => logger.error('pay: could not queue a sync', { ...log, ...errorFields(err) }));
    }
  }
}

export function startPayLoop(deps: PayDeps, databaseUrl: string): Promise<JobLoop> {
  return startJobLoop({
    name: 'pay',
    channel: 'order_jobs',
    databaseUrl,
    logger: deps.logger,
    sweepMs: ORDER_SWEEP_MS,
    maxConcurrent: ORDER_MAX_CONCURRENT,
    beforeSweep: () => failStaleOrderJobs(deps.db),
    claim: () => claimNextOrderJob(deps.db),
    run: (id) => runOrderJob(deps, id),
  });
}
