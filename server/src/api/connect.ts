// Connecting a grocery app (design §7.10). The user types phone and OTP on our
// page; the api SEALS them (it holds only the vault public key and can never
// read them back) and the worker does the rest in a headless browser.
//
//   POST /api/connect/:vendor              { phone }  → 202 { id, status }
//   GET  /api/connect/requests/:id                    → the attempt's status
//   POST /api/connect/requests/:id/otp     { otp }    → 202
//   POST /api/connect/:vendor/cancel                  → 200 { cancelled }
//   GET  /api/connections                             → the household's connections
//   POST /api/connections/:id/address  { addressId }   → where its carts are filled
//
// Every route is household-scoped via requireHousehold: an id from the URL is
// only ever looked up together with the session's household.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import {
  CONNECTABLE_VENDORS,
  CONNECT_CANCELLABLE_STATUSES,
  CONNECTION_SYNCS_SHOWN,
  DELIVERED_STATUS,
  CONNECT_REQUEST_TTL_SECONDS,
  MAX_BODY_BYTES,
  OTP_PATTERN,
  PHONE_PATTERN,
  type ConnectableVendor,
} from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { seal } from '../vault.js';
import { requireHousehold } from './households.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "+91 98765 43210", "098765 43210", "9876543210" → "9876543210", or null.
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[\s()-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return PHONE_PATTERN.test(digits) ? digits : null;
}

function vaultKey(deps: AuthDeps): string {
  const key = deps.config.vault.publicKey;
  if (!key) throw new HttpError(503, 'connecting grocery apps is not configured on this server');
  return key;
}

interface RequestRow {
  id: string;
  vendor: string;
  status: string;
  phone_last4: string;
  error_code: string | null;
  expires_at: Date;
}

const toStatus = (r: RequestRow) => ({
  id: r.id,
  vendor: r.vendor,
  status: r.status,
  phoneLast4: r.phone_last4,
  errorCode: r.error_code,
  expiresAt: r.expires_at.toISOString(),
});

export async function handleConnect(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { db } = deps;

  // POST /api/connect/:vendor
  const start = url.pathname.match(/^\/api\/connect\/([a-z]+)$/);
  if (start && req.method === 'POST') {
    const vendor = start[1];
    if (!(CONNECTABLE_VENDORS as readonly string[]).includes(vendor)) throw new HttpError(400, `${vendor} can't be connected yet`);
    const publicKey = vaultKey(deps);
    const { userId, household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { phone?: unknown };
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'enter a 10-digit Indian mobile number');

    const id = randomUUID();
    try {
      const { rows } = await db.query<RequestRow>(
        `insert into connect_requests (id, household_id, user_id, vendor, phone_sealed, phone_last4, status, expires_at)
         values ($1, $2, $3, $4, $5, $6, 'requested', now() + make_interval(secs => $7))
         returning id, vendor, status, phone_last4, error_code, expires_at`,
        [id, household.id, userId, vendor as ConnectableVendor, seal(publicKey, phone, `connect_requests:${id}:phone`), phone.slice(-4), CONNECT_REQUEST_TTL_SECONDS],
      );
      // Wake the worker now rather than at its next sweep.
      await db.query(`select pg_notify('connect_requests', $1)`, [id]);
      sendJson(res, 202, toStatus(rows[0]));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, `a ${vendor} connection is already in progress`);
      throw err;
    }
    return true;
  }

  // POST /api/connect/:vendor/cancel — ends the caller's own in-flight attempt
  // for this vendor (wrong number, changed mind). By vendor rather than id, so
  // a page that lost the id (reload, another tab) can still clear it.
  const cancel = url.pathname.match(/^\/api\/connect\/([a-z]+)\/cancel$/);
  if (cancel && req.method === 'POST') {
    const vendor = cancel[1];
    if (!(CONNECTABLE_VENDORS as readonly string[]).includes(vendor)) throw new HttpError(400, `${vendor} can't be connected yet`);
    const { userId, household } = await requireHousehold(deps, req);
    const { rowCount } = await db.query(
      `update connect_requests
          set status = 'cancelled', phone_sealed = null, otp_sealed = null, updated_at = now()
        where user_id = $1 and household_id = $2 and vendor = $3 and status = any($4::text[])`,
      [userId, household.id, vendor, CONNECT_CANCELLABLE_STATUSES],
    );
    if (!rowCount) {
      const checking = await db.query(
        `select 1 from connect_requests where user_id = $1 and household_id = $2 and vendor = $3 and status = 'verifying'`,
        [userId, household.id, vendor],
      );
      if (checking.rowCount) throw new HttpError(409, 'Your code is being checked. This takes a few seconds.');
    }
    sendJson(res, 200, { cancelled: Boolean(rowCount) });
    return true;
  }

  // GET /api/connect/requests/:id
  const status = url.pathname.match(/^\/api\/connect\/requests\/([^/]+)$/);
  if (status && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    if (!UUID.test(status[1])) throw new HttpError(404, 'not found');
    const { rows } = await db.query<RequestRow>(
      `select id, vendor, status, phone_last4, error_code, expires_at
         from connect_requests where id = $1 and household_id = $2`,
      [status[1], household.id],
    );
    if (!rows[0]) throw new HttpError(404, 'not found');
    sendJson(res, 200, toStatus(rows[0]));
    return true;
  }

  // POST /api/connect/requests/:id/otp
  const otpRoute = url.pathname.match(/^\/api\/connect\/requests\/([^/]+)\/otp$/);
  if (otpRoute && req.method === 'POST') {
    const publicKey = vaultKey(deps);
    const { household } = await requireHousehold(deps, req);
    const id = otpRoute[1];
    if (!UUID.test(id)) throw new HttpError(404, 'not found');
    const body = (await readJson(req, MAX_BODY_BYTES)) as { otp?: unknown };
    const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
    if (!OTP_PATTERN.test(otp)) throw new HttpError(400, 'enter the 4–6 digit code');

    const { rows } = await db.query<RequestRow>(
      `update connect_requests
          set otp_sealed = $3, status = 'verifying', updated_at = now()
        where id = $1 and household_id = $2 and status = 'otp_sent' and expires_at > now()
      returning id, vendor, status, phone_last4, error_code, expires_at`,
      [id, household.id, seal(publicKey, otp, `connect_requests:${id}:otp`)],
    );
    if (!rows[0]) {
      const exists = await db.query('select 1 from connect_requests where id = $1 and household_id = $2', [id, household.id]);
      throw exists.rowCount ? new HttpError(409, 'this attempt is not waiting for a code') : new HttpError(404, 'not found');
    }
    await db.query(`select pg_notify('connect_requests', $1)`, [id]);
    sendJson(res, 202, toStatus(rows[0]));
    return true;
  }

  // POST /api/connections/:id/address — which of the app's own saved
  // addresses this household's carts are filled for (design §19 stage 1).
  const address = url.pathname.match(/^\/api\/connections\/([0-9a-f-]{36})\/address$/);
  if (address && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { addressId?: unknown };
    const { rows } = await db.query<{ addresses: { id: string; label: string; display: string; lat: number; lng: number; name: string; source?: string }[] }>(
      'select addresses from vendor_connections where id = $1 and household_id = $2',
      [address[1], household.id],
    );
    if (!rows.length) throw new HttpError(404, 'No such app.');
    const chosen = rows[0].addresses?.find((a) => a.id === body.addressId);
    if (!chosen) throw new HttpError(400, 'Pick one of the addresses saved in the app.');
    await db.query('update vendor_connections set cart_address = $2, updated_at = now() where id = $1', [
      address[1],
      JSON.stringify({ ...chosen, chosenByHousehold: true }),
    ]);
    sendJson(res, 200, { cartAddress: { id: chosen.id, label: chosen.label, chosenByHousehold: true } });
    return true;
  }

  // GET /api/connections — never any session material.
  if (url.pathname === '/api/connections' && req.method === 'GET') {
    const { userId, household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{
      id: string;
      user_id: string;
      email: string | null;
      member_name: string | null;
      vendor: string;
      phone_last4: string;
      status: string;
      last_sync_at: Date | null;
      orders: string;
      first_order_at: Date | null;
      last_order_at: Date | null;
      addresses: { id: string; label: string; display: string; name?: string; source?: string }[];
      cart_address: { id: string; label: string; chosenByHousehold?: boolean } | null;
      cards: string[];
      free_delivery_above: string | null;
      delivery_fee: string | null;
      checkout_ready: boolean | null;
    }>(
      `select c.id, c.user_id, u.email, u.display_name as member_name, c.vendor, c.phone_last4, c.status, c.last_sync_at, c.addresses, c.cart_address, c.cards,
              c.free_delivery_above, c.delivery_fee, c.checkout_ready,
              count(o.id) as orders, min(o.placed_at) as first_order_at, max(o.placed_at) as last_order_at
         from vendor_connections c
         join users u on u.id = c.user_id
         left join raw_orders o on o.connection_id = c.id and o.status = $2
        where c.household_id = $1
        group by c.id, u.email, u.display_name
        order by c.vendor, c.created_at`,
      [household.id, DELIVERED_STATUS],
    );
    // The most recent syncs per connection: when each ran and what it added.
    const { rows: syncs } = await db.query<{ connection_id: string; created_at: Date; completed_at: Date | null; status: string; orders_done: number }>(
      `select connection_id, created_at, completed_at, status, orders_done
         from (select j.*, row_number() over (partition by connection_id order by created_at desc) as n
                 from import_jobs j where household_id = $1) recent
        where n <= $2
        order by created_at desc`,
      [household.id, CONNECTION_SYNCS_SHOWN],
    );
    sendJson(res, 200, {
      connections: rows.map((r) => ({
        id: r.id,
        vendor: r.vendor,
        // Whose account it is. Only its owner can reconnect it: the OTP goes
        // to their phone (design §19).
        mine: r.user_id === userId,
        memberEmail: r.email,
        memberName: r.member_name,
        phoneLast4: r.phone_last4,
        status: r.status,
        lastSyncAt: r.last_sync_at?.toISOString() ?? null,
        orders: Number(r.orders),
        firstOrderAt: r.first_order_at?.toISOString() ?? null,
        lastOrderAt: r.last_order_at?.toISOString() ?? null,
        // Where its carts are filled: the app's own saved addresses, and the
        // one this household picked (design §19 stage 1).
        // `name` and `source` come too: a list can hold four entries called
        // "Home" in four cities, and two of this household's were shared to
        // the account from somebody else's. Without them the page is asking
        // the household to choose between identical-looking rows.
        addresses: (r.addresses ?? []).map((a) => ({ id: a.id, label: a.label, display: a.display, name: a.name, source: a.source })),
        // Whether this session can still reach the vendor's own checkout.
        // Null means nobody has looked, which the page must not read as a no.
        checkoutReady: r.checkout_ready,
        // The saved cards, by the names the app's own payment screen shows
        // them under (design §19 stage 3). Never a number and never a token:
        // the name is how the household says which one they mean. Empty
        // until a payment screen has been read at least once.
        cards: r.cards ?? [],
        // What this store charges for delivery and what it says delivery is
        // free above, as of the last cart read. Both null until it has said,
        // and the app then says nothing about delivery at all.
        delivery: {
          fee: r.delivery_fee === null ? null : Number(r.delivery_fee),
          freeAbove: r.free_delivery_above === null ? null : Number(r.free_delivery_above),
        },
        cartAddress: r.cart_address
          ? { id: r.cart_address.id, label: r.cart_address.label, chosenByHousehold: r.cart_address.chosenByHousehold === true }
          : null,
        syncs: syncs
          .filter((s) => s.connection_id === r.id)
          .map((s) => ({
            startedAt: s.created_at.toISOString(),
            completedAt: s.completed_at?.toISOString() ?? null,
            status: s.status,
            ordersAdded: s.orders_done,
          })),
      })),
    });
    return true;
  }

  return false;
}
