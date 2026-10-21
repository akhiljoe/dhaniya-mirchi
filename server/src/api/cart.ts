// Add to cart (design §19 Ordering, stage 1). Household-scoped via
// requireHousehold; the worker does the work, because only it can open a
// household's vendor session (§14.3).
//
//   POST /api/cart/add        { vendor, items: [{item, product, pack, qty}] } → 202 { id }
//   GET  /api/cart/jobs       → the household's recent carts, newest first
//   GET  /api/cart/jobs/:id   → { status, result, errorCode }
//   GET  /api/cart/prompted   → what the app has put in carts, so the pages
//                               can keep those purchases out of the rate (§9.2)
//
// Nothing is ordered and no payment is touched: the items land in the
// household's own cart in the vendor's app, where they pay as usual.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { CART_MAX_ALTERNATIVES, CART_MAX_ITEMS, CART_QUEUE_MAX, CART_RECENT_JOBS, CART_STALE_SECONDS, CART_VENDORS, MAX_BODY_BYTES, PRODUCT_NAME_MAX, PROMPTED_KEEP_DAYS } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireHousehold } from './households.js';

export interface CartWantInput {
  item: string;
  product: string;
  pack: string;
  qty: number;
  // 'search': something never bought before (a recipe's new ingredient), so
  // the worker takes what the store sells under that name (design §19).
  match?: 'exact' | 'search';
  // The rest of the household's ranking for this item, for when the store
  // has not got the first: products they have bought before, best first,
  // each with its pack. The worker takes the first the store has and says
  // which it took (adapters/alternatives.ts).
  alternatives?: { product: string; pack: string }[];
}

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/;
const UUID = '([0-9a-f-]{36})';

const text = (x: unknown, what: string, max: number): string => {
  // Control characters are checked before spaces are tidied, or a newline
  // would simply become a space.
  if (typeof x !== 'string' || CONTROL.test(x)) throw new HttpError(400, `${what} is not valid.`);
  const s = x.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max) throw new HttpError(400, `${what} is not valid.`);
  return s;
};

export function validateWants(body: unknown): CartWantInput[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Pick something to add.');
  if (items.length > CART_MAX_ITEMS) throw new HttpError(400, `At most ${CART_MAX_ITEMS} items at a time.`);
  return items.map((raw) => {
    const i = (raw ?? {}) as Record<string, unknown>;
    const qty = i.qty;
    if (!Number.isInteger(qty) || (qty as number) < 0 || (qty as number) > 20) throw new HttpError(400, 'How many? Between 0 and 20.');
    const match = i.match === 'search' ? 'search' : 'exact';
    // The next products down, each checked like the first. A short list: it
    // is the household's own ranking, and each one is a page the worker may
    // have to open.
    const alternatives = Array.isArray(i.alternatives)
      ? i.alternatives.slice(0, CART_MAX_ALTERNATIVES).map((raw) => {
          const a = (raw ?? {}) as Record<string, unknown>;
          // A pack the page does not know arrives empty. That is not an
          // invalid pack, it is no pack - and "The pack is not valid" for it
          // stopped a whole send (2026-09-23).
          return { product: text(a.product, 'The product', PRODUCT_NAME_MAX), pack: typeof a.pack === 'string' && a.pack.trim() ? text(a.pack, 'The pack', 60) : '' };
        })
      : undefined;
    return {
      item: text(i.item, 'The item', 60),
      product: text(i.product, 'The product', PRODUCT_NAME_MAX),
      // Searching has no pack to ask for: the store's cheapest in stock.
      pack: match === 'search' ? '' : text(i.pack, 'The pack', 60),
      qty: qty as number,
      match,
      ...(alternatives?.length ? { alternatives } : {}),
    };
  });
}

export async function handleCart(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { db } = deps;

  if (url.pathname === '/api/cart/add' && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { vendor?: unknown };
    const vendor = CART_VENDORS.find((v) => v === body.vendor);
    if (!vendor) throw new HttpError(400, 'Say which app.');
    const wanted = validateWants(body);

    // The household's own connection to that app, ready to use.
    const { rows: conns } = await db.query<{ id: string; status: string }>(
      `select id, status from vendor_connections where household_id = $1 and vendor = $2 order by created_at limit 1`,
      [household.id, vendor],
    );
    if (!conns.length) throw new HttpError(409, 'Connect that app first, on the Grocery apps page.');
    if (conns[0].status !== 'active') throw new HttpError(409, 'That app needs connecting again. Open the Grocery apps page.');

    // More may be sent while one is being filled: they queue, and the worker
    // fills this household's carts one after another.
    const { rowCount: waiting } = await db.query(
      `select 1 from cart_jobs where household_id = $1 and status in ('requested', 'running')
          and updated_at > now() - make_interval(secs => $2)`,
      [household.id, CART_STALE_SECONDS],
    );
    if ((waiting ?? 0) >= CART_QUEUE_MAX) throw new HttpError(429, 'A few carts are already on their way. Wait for those to finish.');

    const { rows } = await db.query<{ id: string }>(
      `insert into cart_jobs (household_id, connection_id, user_id, vendor, wanted, status)
       values ($1, $2, $3, $4, $5, 'requested') returning id`,
      [household.id, conns[0].id, userId, vendor, JSON.stringify(wanted)],
    );
    await db.query(`select pg_notify('cart_jobs', $1)`, [rows[0].id]);
    sendJson(res, 202, { id: rows[0].id });
    return true;
  }

  if (url.pathname === '/api/cart/prompted' && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ item: string; vendor: string; product: string; quantity: number; created_at: Date }>(
      `select item, vendor, product, quantity, created_at from prompted_adds
        where household_id = $1 and created_at > now() - make_interval(days => $2)
        order by created_at`,
      [household.id, PROMPTED_KEEP_DAYS],
    );
    sendJson(res, 200, {
      adds: rows.map((r) => ({ item: r.item, vendor: r.vendor, product: r.product, quantity: r.quantity, addedAt: r.created_at.toISOString() })),
    });
    return true;
  }

  if (url.pathname === '/api/cart/jobs' && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    // `ordered`: an order exists at the store for this cart - Pay was pressed
    // on it, whether or not the money was read back. The page must hear this
    // from here, not remember it: a cart whose order went through while the
    // payment sheet was closed came back as "ready · Pay on Instamart" on
    // the next load (2026-09-23), for an order already placed.
    const { rows } = await db.query<{
      id: string;
      status: string;
      vendor: string;
      wanted: CartWantInput[];
      result: unknown;
      error_code: string | null;
      created_at: Date;
      ordered: boolean;
    }>(
      `select j.id, j.status, j.vendor, j.wanted, j.result, j.error_code, j.created_at,
              exists(select 1 from order_jobs o where o.cart_job_id = j.id and o.pay_pressed_at is not null) as ordered
         from cart_jobs j
        where j.household_id = $1 order by j.created_at desc limit $2`,
      [household.id, CART_RECENT_JOBS],
    );
    sendJson(res, 200, {
      jobs: rows.map((r) => ({
        id: r.id,
        status: r.status,
        vendor: r.vendor,
        items: r.wanted.length,
        result: r.result,
        errorCode: r.error_code,
        at: r.created_at.toISOString(),
        ordered: r.ordered,
      })),
    });
    return true;
  }

  // Stopping one. A job nobody has claimed yet stops dead. One already
  // running cannot be killed - it is driving a real browser at a real cart -
  // so the request is recorded and the worker reads it between items. Either
  // way the answer says which happened, because "stopped" and "stopping,
  // what is in the cart stays" are different things to a household.
  const stop = url.pathname.match(new RegExp(`^/api/cart/jobs/${UUID}/cancel$`));
  if (stop && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ status: string }>('select status from cart_jobs where id = $1 and household_id = $2', [stop[1], household.id]);
    if (!rows.length) throw new HttpError(404, 'No such cart.');
    if (rows[0].status === 'requested') {
      await db.query(`update cart_jobs set status = 'failed', error_code = 'cancelled', cancel_requested_at = now(), updated_at = now() where id = $1`, [stop[1]]);
      sendJson(res, 200, { stopped: true });
      return true;
    }
    if (rows[0].status === 'running') {
      await db.query('update cart_jobs set cancel_requested_at = now() where id = $1', [stop[1]]);
      sendJson(res, 200, { stopped: false });
      return true;
    }
    throw new HttpError(409, 'That cart has already finished. Check it in the app.');
  }

  const job = url.pathname.match(new RegExp(`^/api/cart/jobs/${UUID}$`));
  if (job && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ status: string; result: unknown; error_code: string | null; vendor: string }>(
      'select status, result, error_code, vendor from cart_jobs where id = $1 and household_id = $2',
      [job[1], household.id],
    );
    if (!rows.length) throw new HttpError(404, 'No such cart.');
    sendJson(res, 200, { status: rows[0].status, result: rows[0].result, errorCode: rows[0].error_code, vendor: rows[0].vendor });
    return true;
  }

  return false;
}
