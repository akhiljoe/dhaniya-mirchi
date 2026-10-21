// Paying for the cart from the app (design §19 stages 2-3). Household-scoped
// via requireHousehold; the worker does the work, because only it can open a
// household's vendor session (§14.3).
//
//   GET  /api/order/live       → the order this household has on the go, or null
//   POST /api/order            { vendor, method, cardLabel?, maxTotal, cartJobId? } → 202 { id }
//   GET  /api/order/:id        → what it is waiting for, and how it ended
//   POST /api/order/:id/agree  { total } → 204, the vendor's own price, said yes to
//   POST /api/order/:id/secret { kind: 'cvv' | 'otp', value } → 204
//   POST /api/order/:id/cancel → 204, only while nothing has been ordered
//
// The CVV and the OTP are handled exactly as the connect OTP is (§7.10): the
// household's browser sends the digits over TLS, this route seals them to the
// vault's public key before anything is written, and only the worker can open
// them (§14.3). They are never logged, never returned, and the sealed value
// is cleared the moment the worker has typed it.
//
// What that leaves: for the length of one request the digits are in this
// process's memory. Sealing in the browser instead would close that, and an
// app that drove the vendor's page on the household's own phone would close
// it completely - neither number would ever leave the device. Both are worth
// doing and neither is done here.
//
// `maxTotal` is the number the household saw when they tapped. The worker
// re-reads the vendor's own total and refuses to pay more than this, so the
// route's job is only to record it honestly.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { CART_VENDORS, CVV_PATTERN, MAX_BODY_BYTES, ON_DELIVERY_VENDORS, ORDER_HARD_CAP_RUPEES, OTP_PATTERN, PAY_VENDORS } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { seal } from '../vault.js';
import { requireHousehold } from './households.js';

function vaultKey(deps: AuthDeps): string {
  const key = deps.config.vault.publicKey;
  if (!key) throw new HttpError(503, 'Paying from the app is not set up on this server.');
  return key;
}

const UUID = '([0-9a-f-]{36})';
// Statuses in which the household is being waited on or the worker is busy.
const LIVE = ['requested', 'running', 'awaiting_ok', 'awaiting_cvv', 'paying', 'awaiting_otp'];

// The digits, checked for shape only so a typo is caught here rather than on
// the vendor's payment screen. Never logged and never echoed back.
export function validateSecret(kind: 'cvv' | 'otp', x: unknown): string {
  const v = typeof x === 'string' ? x.trim() : '';
  const ok = kind === 'cvv' ? CVV_PATTERN.test(v) : OTP_PATTERN.test(v);
  if (!ok) throw new HttpError(400, kind === 'cvv' ? 'The CVV is the 3 or 4 digits on the card.' : 'Enter the 4 to 6 digit code.');
  return v;
}

export function validateOrder(body: unknown): { vendor: string; method: 'card' | 'on_delivery'; cardLabel: string | null; maxTotal: number; cartJobId: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const vendor = CART_VENDORS.find((v) => v === b.vendor);
  if (!vendor) throw new HttpError(400, 'Say which app.');
  const method = b.method === 'card' || b.method === 'on_delivery' ? b.method : null;
  if (!method) throw new HttpError(400, 'Pick how to pay.');
  // The card is named by the words the vendor's own screen shows, which is
  // how the worker finds the row. Never a number and never a token.
  const cardLabel = method === 'card' ? String(b.cardLabel ?? '').replace(/\s+/g, ' ').trim() : '';
  if (cardLabel.length > 80) throw new HttpError(400, 'Pick which card.');
  // No card named is allowed: the app may not know the cards on an app whose
  // checkout has never been opened. The worker then takes the one card the
  // payment screen shows, and refuses when there is more than one to choose.
  const maxTotal = Number(b.maxTotal);
  if (!Number.isFinite(maxTotal) || maxTotal <= 0) throw new HttpError(400, 'How much is this order?');
  if (maxTotal > ORDER_HARD_CAP_RUPEES) throw new HttpError(400, `Orders are capped at ₹${ORDER_HARD_CAP_RUPEES}.`);
  // The cart this is paying for. The worker checks the payment screen against
  // it, and pays through the connection that cart was filled on - a household
  // with two accounts on one vendor must not fill one cart and pay from the
  // other.
  const raw = typeof b.cartJobId === 'string' ? b.cartJobId.trim() : '';
  const cartJobId = /^[0-9a-f-]{36}$/.test(raw) ? raw : null;
  return { vendor, method, cardLabel: method === 'card' && cardLabel ? cardLabel : null, maxTotal, cartJobId };
}

export async function handleOrder(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { db } = deps;

  if (url.pathname === '/api/order' && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    const asked = validateOrder(await readJson(req, MAX_BODY_BYTES));

    // The cart being paid for, if one was named: its own connection is the one
    // to pay through, and its own line count is what the payment screen has to
    // agree with.
    //
    // That count is the VENDOR's count of its cart (`result.cartLines`), not
    // the number of lines in our answer. Our answer has a line per thing we
    // were asked for, including the ones the store would not sell: a cart of
    // seven where parsley was not stocked is six lines in the app, and
    // counting our seven made the payment screen look like a cart that had
    // changed under the household. It stopped two real orders on 2026-09-22.
    // Older carts, filled before the worker recorded it, fall back to
    // counting the lines that actually landed.
    //
    // And it is the count the vendor's OWN payment screen will state, which
    // is not the same thing on every vendor. Instamart's screen says "9
    // items" for paneer x2, carrot x5, cheese x1, cheese x1 - units, not
    // lines - and compared against three lines it read as a cart that had
    // changed under the household, and stopped a payment they had agreed to
    // (2026-09-23). Blinkit's screen states the number of lines. So each is
    // given the count it will be checked against.
    //
    // The cart decides the vendor, not the page. A cart filled on one app and
    // an order asked for on another is not a mismatch to shrug at by dropping
    // the link - that is exactly how one app's cart would be "paid for"
    // through the other's account with nothing checked against it. It
    // happened: the page sent every order as Instamart whatever cart it was
    // for, and this lookup used to filter by that vendor and quietly find
    // nothing.
    const { rows: carts } = asked.cartJobId
      ? await db.query<{ id: string; connection_id: string; vendor: string; lines: number | null }>(
          `select id, connection_id, vendor,
                  coalesce(case when vendor = 'instamart' then (result->>'cartUnits')::int end,
                           (result->>'cartLines')::int,
                           (select count(*)::int from jsonb_array_elements(coalesce(result->'lines', '[]'::jsonb)) l
                             where coalesce((l->>'inCart')::int, 0) > 0)) as lines
             from cart_jobs where id = $1 and household_id = $2 and status = 'done'`,
          [asked.cartJobId, household.id],
        )
      : { rows: [] };
    const cart = carts[0] ?? null;
    if (asked.cartJobId && !cart) throw new HttpError(404, 'That cart is not one this household filled.');
    if (cart && cart.vendor !== asked.vendor) throw new HttpError(400, `That cart is on ${cart.vendor}, not ${asked.vendor}.`);
    if (!PAY_VENDORS.includes(asked.vendor as (typeof PAY_VENDORS)[number])) {
      throw new HttpError(400, 'Paying on that app from here is not ready yet.');
    }
    if (asked.method === 'on_delivery' && !ON_DELIVERY_VENDORS.includes(asked.vendor as (typeof ON_DELIVERY_VENDORS)[number])) {
      throw new HttpError(400, 'That app does not offer pay on delivery here. Pay by card.');
    }

    // The cart's own connection when there is one, and otherwise the
    // household's first on that vendor. Two plain queries rather than one
    // clever one: a query with a parameter it does not use is an error
    // Postgres reports as a 500.
    const { rows: conns } = cart
      ? await db.query<{ id: string; status: string }>(`select id, status from vendor_connections where id = $1 and household_id = $2`, [
          cart.connection_id,
          household.id,
        ])
      : await db.query<{ id: string; status: string }>(
          `select id, status from vendor_connections where household_id = $1 and vendor = $2 order by created_at limit 1`,
          [household.id, asked.vendor],
        );
    if (!conns.length) throw new HttpError(409, 'Connect that app first, on the Grocery apps page.');
    if (conns[0].status !== 'active') throw new HttpError(409, 'That app needs connecting again. Open the Grocery apps page.');

    // One order at a time per household. The table enforces this too; asking
    // here turns a database error into a sentence.
    const { rowCount: live } = await db.query(`select 1 from order_jobs where household_id = $1 and status = any($2)`, [household.id, LIVE]);
    if (live) throw new HttpError(409, 'An order is already going through. Finish that one first.');

    // A cart that has already been paid for is not paid for twice. The page
    // stops offering Pay once the order is done, but the page is not what
    // guards money: a stale tab, or a second phone, would pay again.
    if (cart) {
      // Any order for this cart on which Pay was PRESSED, paid or not: the
      // vendor makes the order before the money moves, so an order exists
      // at the store, and a second Pay is a second order. "Unconfirmed" -
      // paid at the store, unread by us - slipped past a check on `paid`
      // alone and offered Pay again on 2026-09-23.
      const { rowCount: placed } = await db.query(`select 1 from order_jobs where cart_job_id = $1 and pay_pressed_at is not null`, [cart.id]);
      if (placed) throw new HttpError(409, 'An order for that cart was already placed. Check the app.');
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into order_jobs (household_id, connection_id, user_id, vendor, method, card_label, max_total, cart_job_id, cart_lines, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested') returning id`,
      [household.id, conns[0].id, userId, asked.vendor, asked.method, asked.cardLabel, asked.maxTotal, cart?.id ?? null, cart?.lines ?? null],
    );
    await db.query(`select pg_notify('order_jobs', $1)`, [rows[0].id]);
    sendJson(res, 202, { id: rows[0].id });
    return true;
  }

  // Saying yes to the vendor's own total, which is not the cart's: the
  // checkout adds fees the cart call never spells out. Only the exact number
  // the payment screen showed can be agreed to - a page cannot send some
  // other figure, and a stale tap on an older price agrees to nothing.
  // The order this household has on the go. Without this an order lives only
  // in the page that started it: close that page while it is waiting for a
  // bank's code and the code can never be given, while the order it belongs
  // to is already placed (seen 2026-09-22).
  if (url.pathname === '/api/order/live' && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ id: string }>(
      `select id from order_jobs where household_id = $1 and status = any($2) order by created_at desc limit 1`,
      [household.id, LIVE],
    );
    sendJson(res, 200, { id: rows[0]?.id ?? null });
    return true;
  }

  const agree = url.pathname.match(new RegExp(`^/api/order/${UUID}/agree$`));
  if (agree && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { total?: unknown };
    const total = Number(body.total);
    if (!Number.isFinite(total) || total <= 0) throw new HttpError(400, 'That did not come through. Try again.');
    if (total > ORDER_HARD_CAP_RUPEES) throw new HttpError(400, `Orders are capped at ₹${ORDER_HARD_CAP_RUPEES}.`);
    const { rowCount } = await db.query(
      `update order_jobs set agreed_total = $3, updated_at = now()
        where id = $1 and household_id = $2 and status = 'awaiting_ok' and vendor_total = $3`,
      [agree[1], household.id, total],
    );
    if (!rowCount) throw new HttpError(409, 'That price is not the one being asked about.');
    res.writeHead(204).end();
    return true;
  }

  const secret = url.pathname.match(new RegExp(`^/api/order/${UUID}/secret$`));
  if (secret && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    const publicKey = vaultKey(deps);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { kind?: unknown; value?: unknown };
    const kind = body.kind === 'cvv' || body.kind === 'otp' ? body.kind : null;
    if (!kind) throw new HttpError(400, 'That did not come through. Try again.');
    const sealed = seal(publicKey, validateSecret(kind, body.value), `order_jobs:${secret[1]}:${kind}`);

    // Only into the job that is waiting for exactly this, and only that
    // household's job. A CVV cannot be posted into a job waiting for an OTP,
    // and neither can be posted into one that is not waiting at all.
    const want = kind === 'cvv' ? 'awaiting_cvv' : 'awaiting_otp';
    const { rowCount } = await db.query(
      `update order_jobs set secret_sealed = $3, secret_kind = $4, secret_at = now(), updated_at = now()
        where id = $1 and household_id = $2 and status = $5 and secret_sealed is null`,
      [secret[1], household.id, sealed, kind, want],
    );
    if (!rowCount) throw new HttpError(409, 'That order is not waiting for this.');
    res.writeHead(204).end();
    return true;
  }

  const cancel = url.pathname.match(new RegExp(`^/api/order/${UUID}/cancel$`));
  if (cancel && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    // Nothing ordered yet: the row is simply failed, and no browser has to be
    // told anything.
    const { rowCount } = await db.query(
      `update order_jobs set status = 'failed', error_code = 'cancelled', secret_sealed = null, secret_kind = null, updated_at = now()
        where id = $1 and household_id = $2 and pay_pressed_at is null and status = any($3)`,
      [cancel[1], household.id, LIVE],
    );
    if (rowCount) {
      res.writeHead(204).end();
      return true;
    }
    // Pay HAS been pressed, so there is a real order at the vendor and a
    // browser of ours is sitting on the bank's own page. Rewriting the row
    // here would be a lie about both. The worker is told instead: it stops
    // waiting for the code, takes the vendor's own way out of the payment,
    // and is the only thing that says how this ended.
    const { rowCount: asked } = await db.query(
      `update order_jobs set cancel_requested = true, secret_sealed = null, secret_kind = null, updated_at = now()
        where id = $1 and household_id = $2 and status = any($3)`,
      [cancel[1], household.id, LIVE],
    );
    if (!asked) throw new HttpError(409, 'That order is already finished. Check the app.');
    res.writeHead(204).end();
    return true;
  }

  const one = url.pathname.match(new RegExp(`^/api/order/${UUID}$`));
  if (one && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{
      status: string;
      method: string;
      card_label: string | null;
      max_total: string;
      agreed_total: string | null;
      vendor_total: string | null;
      bank_total: string | null;
      vendor_order_id: string | null;
      paid: boolean;
      pay_pressed_at: Date | null;
      error_code: string | null;
      vendor: string;
    }>(
      `select status, method, card_label, max_total, agreed_total, vendor_total, bank_total, vendor_order_id, paid, pay_pressed_at, error_code, vendor
         from order_jobs where id = $1 and household_id = $2`,
      [one[1], household.id],
    );
    if (!rows.length) throw new HttpError(404, 'No such order.');
    const r = rows[0];
    sendJson(res, 200, {
      status: r.status,
      vendor: r.vendor,
      method: r.method,
      cardLabel: r.card_label,
      agreedTotal: Number(r.agreed_total ?? r.max_total),
      // What the vendor's own payment screen says, which is not what the cart
      // said: the checkout adds fees the cart call never spells out. When the
      // job is `awaiting_ok` this is the number being asked about.
      vendorTotal: r.vendor_total === null ? null : Number(r.vendor_total),
      // What the BANK says it is taking, off its own page. The only figure
      // here that cannot be stale: the vendor can change the order between
      // the household agreeing to a price and the gateway being called, and
      // on 2026-09-23 it did - Rs 320 agreed, Rs 255 asked for. Null when the
      // bank's page does not say, which is common.
      bankTotal: r.bank_total === null ? null : Number(r.bank_total),
      orderId: r.vendor_order_id,
      paid: r.paid,
      // The state this whole flow is built to be able to show: the vendor
      // made an order and the money did not move. It turns on Pay having been
      // PRESSED, not on our having caught the order id - the vendor creates
      // the order before the money moves, so once that button is pressed an
      // order may exist whether or not we can name it, and a household told
      // nothing would find out at the door.
      unpaidOrder: !!r.pay_pressed_at && !r.paid && r.status === 'failed',
      errorCode: r.error_code,
    });
    return true;
  }

  return false;
}
