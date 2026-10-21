// "Your history is in" (design §7.10, §13). Run on every import-loop sweep:
// finds first imports that reached a milestone — ready to use, or complete —
// and tells the household's browsers, once per milestone.
//
//  - Only a connection's FIRST import is news; later syncs stay quiet.
//  - A milestone is claimed (its *_notified_at set) before anything is sent,
//    so two sweeps or two workers never send it twice. A failed send is not
//    retried — a missed notice beats a repeated one.
//  - Nothing fires during the household's quiet hours (§13.2): the milestone
//    stays unclaimed and goes out on the first sweep after they end.
//  - A browser the push service reports gone (404/410) is forgotten.
//  - Push endpoints are capabilities: never logged, never in an error.
import webpush from 'web-push';

import type { PushConfig } from '../config.js';
import { PUSH_TTL_SECONDS, QUIET_HOURS_END, QUIET_HOURS_START, VENDOR_NAMES } from '../constants.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSender {
  // `gone`: the push service says this browser no longer exists.
  send(sub: PushSubscriptionKeys, payload: string): Promise<{ gone: boolean }>;
}

export function webPushSender(push: PushConfig): PushSender {
  if (!push.publicKey || !push.privateKey || !push.subject) throw new Error('web push is not configured');
  const vapidDetails = { subject: push.subject, publicKey: push.publicKey, privateKey: push.privateKey };
  return {
    async send(sub, payload) {
      try {
        await webpush.sendNotification(sub, payload, { vapidDetails, TTL: PUSH_TTL_SECONDS });
        return { gone: false };
      } catch (err) {
        if (err instanceof webpush.WebPushError && (err.statusCode === 404 || err.statusCode === 410)) return { gone: true };
        throw err;
      }
    },
  };
}

export interface NotifyDeps {
  db: Db;
  logger: Logger;
  sender: PushSender;
  now?: Date; // tests pin the clock; the worker passes nothing
}

export function quietHours(now: Date, timezone: string): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return QUIET_HOURS_START > QUIET_HOURS_END
    ? hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END
    : hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

interface Milestone {
  id: string;
  household_id: string;
  vendor: string;
  status: string;
  orders_done: number;
  timezone: string;
}

function noticeFor(m: Milestone): { title: string; body: string } {
  const vendor = VENDOR_NAMES[m.vendor] ?? m.vendor;
  if (m.status === 'complete') {
    return { title: `Your ${vendor} history is in`, body: `We read ${m.orders_done} orders. See what's running low.` };
  }
  return {
    title: 'Your household is ready',
    body: `Your most-bought ${vendor} items are in, so predictions have started. The rest keeps filling in.`,
  };
}

export async function sendImportNotices(deps: NotifyDeps): Promise<number> {
  const { db, logger, sender } = deps;
  const now = deps.now ?? new Date();
  const { rows } = await db.query<Milestone>(
    `select j.id, j.household_id, j.vendor, j.status, j.orders_done, h.timezone
       from import_jobs j join households h on h.id = j.household_id
      where ((j.status = 'complete' and j.complete_notified_at is null)
          or (j.status in ('listing', 'packs') and j.ready_at is not null and j.ready_notified_at is null))
        and not exists (select 1 from import_jobs e
                         where e.connection_id = j.connection_id and e.status = 'complete' and e.created_at < j.created_at)`,
  );

  let sent = 0;
  for (const m of rows) {
    if (quietHours(now, m.timezone)) continue;
    const claimed =
      m.status === 'complete'
        ? await db.query(
            `update import_jobs set complete_notified_at = now(), ready_notified_at = coalesce(ready_notified_at, now())
              where id = $1 and complete_notified_at is null`,
            [m.id],
          )
        : await db.query(
            `update import_jobs set ready_notified_at = now()
              where id = $1 and ready_notified_at is null and complete_notified_at is null`,
            [m.id],
          );
    if (!claimed.rowCount) continue;

    const payload = JSON.stringify({ ...noticeFor(m), url: '/', tag: `import-${m.id}` });
    const { rows: subs } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `select s.id, s.endpoint, s.p256dh, s.auth
         from push_subscriptions s join household_members hm on hm.user_id = s.user_id
        where hm.household_id = $1`,
      [m.household_id],
    );
    for (const s of subs) {
      try {
        const { gone } = await sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        if (gone) await db.query('delete from push_subscriptions where id = $1', [s.id]);
        else sent++;
      } catch (err) {
        // The status code only: the error itself carries the endpoint.
        const status = err instanceof webpush.WebPushError ? err.statusCode : null;
        logger.warn('notify: push failed', { job: m.id, vendor: m.vendor, status });
      }
    }
    logger.info('notify: import milestone sent', { job: m.id, vendor: m.vendor, milestone: m.status === 'complete' ? 'complete' : 'ready', browsers: subs.length });
  }
  return sent;
}

// "Your cart is ready." A fill takes about half a minute and the household
// pressed Send meaning to carry on with something else - usually adding things
// of its own in the vendor's app. Waiting on our progress bar is not a
// reasonable ask, so the finish comes to them instead.
//
// Sent to the person who pressed Send, not the whole household: nobody else
// was waiting for it. Quiet hours do not apply - this answers something they
// did seconds ago, at whatever hour they did it.
interface CartDone {
  id: string;
  user_id: string | null;
  vendor: string;
  status: string;
  added: number;
  to_pay: number | null;
}

// An order waiting on the household. Each question is pushed once; quiet
// hours do not apply, because the order is already under way and for a bank's
// code it is already placed - a household kept in the dark until morning is
// worse off than one woken up.
const ORDER_ASKS: Record<string, { title: string; body: string }> = {
  awaiting_ok: { title: 'Confirm the price', body: 'The app is asking for a bit more than the cart showed. Open DhaniyaMirchi to say yes or no.' },
  awaiting_cvv: { title: 'Your CVV is needed', body: 'Open DhaniyaMirchi to finish paying.' },
  awaiting_otp: { title: 'Your bank sent a code', body: 'The order is placed. Open DhaniyaMirchi and enter the code to pay for it.' },
};

export async function sendOrderNotices(deps: NotifyDeps): Promise<number> {
  const { db, logger, sender } = deps;
  const { rows } = await db.query<{ id: string; user_id: string; status: string }>(
    `select id, user_id, status from order_jobs
      where status = any($1) and (notified_for is null or notified_for is distinct from status)`,
    [Object.keys(ORDER_ASKS)],
  );

  let sent = 0;
  for (const job of rows) {
    const ask = ORDER_ASKS[job.status];
    if (!ask) continue;
    // Claim it first, so two sweeps never ask twice.
    const claimed = await db.query(`update order_jobs set notified_for = $2 where id = $1 and notified_for is distinct from $2`, [job.id, job.status]);
    if (!claimed.rowCount) continue;
    const payload = JSON.stringify({ title: ask.title, body: ask.body, url: '/', tag: `order-${job.id}` });
    const { rows: subs } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1`,
      [job.user_id],
    );
    for (const s of subs) {
      try {
        const { gone } = await sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        if (gone) await db.query('delete from push_subscriptions where id = $1', [s.id]);
        else sent++;
      } catch (err) {
        const status = err instanceof webpush.WebPushError ? err.statusCode : null;
        logger.warn('notify: order push failed', { job: job.id, status });
      }
    }
    logger.info('notify: order notice sent', { job: job.id, asking: job.status, browsers: subs.length });
  }
  return sent;
}

export async function sendCartNotices(deps: NotifyDeps): Promise<number> {
  const { db, logger, sender } = deps;
  const { rows } = await db.query<CartDone>(
    `select j.id, j.user_id, j.vendor, j.status,
            (select count(*) from jsonb_array_elements(coalesce(j.result->'lines', '[]'::jsonb)) l
              where l->>'state' in ('added', 'already_there')) as added,
            (j.result->'bill'->>'toPay')::numeric as to_pay
       from cart_jobs j
      where j.status in ('done', 'failed') and j.notified_at is null and j.user_id is not null`,
  );

  let sent = 0;
  for (const job of rows) {
    const claimed = await db.query(`update cart_jobs set notified_at = now() where id = $1 and notified_at is null`, [job.id]);
    if (!claimed.rowCount) continue;

    const app = job.vendor === 'instamart' ? 'Instamart' : job.vendor === 'blinkit' ? 'Blinkit' : job.vendor;
    const body =
      job.status === 'failed'
        ? 'Nothing was added. Open the app to see what happened.'
        : `${job.added} ${job.added === 1 ? 'item' : 'items'}${job.to_pay ? `, ₹${Math.round(job.to_pay)}` : ''}. Pay in the app.`;
    const payload = JSON.stringify({
      title: job.status === 'failed' ? `Your ${app} cart could not be filled` : `Your ${app} cart is ready`,
      body,
      url: '/',
      tag: `cart-${job.id}`,
    });

    const { rows: subs } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1`,
      [job.user_id],
    );
    for (const s of subs) {
      try {
        const { gone } = await sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        if (gone) await db.query('delete from push_subscriptions where id = $1', [s.id]);
        else sent++;
      } catch (err) {
        const status = err instanceof webpush.WebPushError ? err.statusCode : null;
        logger.warn('notify: cart push failed', { job: job.id, vendor: job.vendor, status });
      }
    }
    logger.info('notify: cart notice sent', { job: job.id, vendor: job.vendor, status: job.status, browsers: subs.length });
  }
  return sent;
}
