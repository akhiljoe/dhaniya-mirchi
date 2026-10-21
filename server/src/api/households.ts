// Households and the signed-in user (design §10.1, §14.3).
//
//   GET  /api/me           the user, their household (or null) and invites waiting for them
//   POST /api/households   create one; the creator is its owner
//
// Membership is the only thing separating two households' data — there is no
// row-level security — so every household-scoped route starts from
// `requireHousehold`, which derives the household from the session, never
// from anything the request names.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { cleanName } from '../auth/oidc.js';
import { currentUser, type AuthDeps } from '../auth/routes.js';
import { fetchPicture, isAllowedPictureUrl } from '../auth/picture.js';
import { CART_VENDORS, DISPLAY_NAME_MAX, HOUSEHOLD_NAME_MAX, MAX_BODY_BYTES, PICTURE_CACHE_SECONDS } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { invitesFor } from './members.js';

export interface Household {
  id: string;
  name: string;
  timezone: string;
  cartVendor?: string | null;
  // Offer what the usual app lacks from the other app. Default on.
  cartFallback?: boolean;
  billingDay: number;
  role: 'owner' | 'member';
}

export async function requireUser(deps: AuthDeps, req: IncomingMessage): Promise<string> {
  const userId = await currentUser(deps, req);
  if (!userId) throw new HttpError(401, 'sign in first');
  return userId;
}

export async function householdOf(deps: AuthDeps, userId: string): Promise<Household | null> {
  const { rows } = await deps.db.query<Household>(
    `select h.id, h.name, h.timezone, h.billing_day as "billingDay", h.cart_vendor as "cartVendor", h.cart_fallback as "cartFallback", m.role
       from household_members m join households h on h.id = m.household_id
      where m.user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

// The session's user and their household, or 401/403. Household-scoped routes
// use the returned id — never an id from the URL or body.
export async function requireHousehold(deps: AuthDeps, req: IncomingMessage): Promise<{ userId: string; household: Household }> {
  const userId = await requireUser(deps, req);
  const household = await householdOf(deps, userId);
  if (!household) throw new HttpError(403, 'create a household first');
  return { userId, household };
}

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function handleHouseholds(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const userId = await requireUser(deps, req);
    const { rows } = await deps.db.query<{ email: string | null; picture_url: string | null; display_name: string | null }>(
      'select email, picture_url, display_name from users where id = $1',
      [userId],
    );
    const pictureUrl = rows[0]?.picture_url ?? null;
    sendJson(res, 200, {
      userId,
      email: rows[0]?.email ?? null,
      // What the pages call this person; null until Google or they say.
      name: rows[0]?.display_name ?? null,
      // Whether there is one — never the provider URL (the api relays it).
      hasPicture: !!pictureUrl && isAllowedPictureUrl(pictureUrl),
      household: await householdOf(deps, userId),
      // Households that invited this user (design §19): shown before connect,
      // so an invited person joins instead of starting an empty household.
      invites: await invitesFor(deps.db, userId),
    });
    return true;
  }

  // What to call this person. Set from the Household page; the pages that
  // named people by their email's local part read it from here on.
  if (url.pathname === '/api/me/name' && req.method === 'POST') {
    const userId = await requireUser(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { name?: unknown };
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, `A name is one line, up to ${DISPLAY_NAME_MAX} characters.`);
    await deps.db.query('update users set display_name = $2 where id = $1', [userId, name]);
    sendJson(res, 200, { name });
    return true;
  }

  // The profile photo, fetched by the server from the pinned Google host and
  // served from our own origin (design §14.3).
  if (url.pathname === '/api/me/picture' && req.method === 'GET') {
    const userId = await requireUser(deps, req);
    const { rows } = await deps.db.query<{ picture_url: string | null }>('select picture_url from users where id = $1', [userId]);
    const picture = rows[0]?.picture_url ? await fetchPicture(rows[0].picture_url) : null;
    if (!picture) throw new HttpError(404, 'no picture');
    res.writeHead(200, {
      'content-type': picture.contentType,
      'content-length': String(picture.bytes.length),
      'cache-control': `private, max-age=${PICTURE_CACHE_SECONDS}`,
      'x-content-type-options': 'nosniff',
    });
    res.end(picture.bytes);
    return true;
  }

  // The day the household's spending month starts (design §10.5). A calendar
  // month is not the month people budget in: a card billed on the 16th makes
  // the useful question "the 16th to the 15th", and the forecast answers
  // about that instead.
  if (url.pathname === '/api/household' && req.method === 'PATCH') {
    const { household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { billingDay?: unknown; cartVendor?: unknown; cartFallback?: unknown };

    // Whether the cart sheet offers, from the other app, what the usual one
    // does not have. A plain switch; anything but a boolean is a mistake.
    if (body.cartFallback !== undefined) {
      if (typeof body.cartFallback !== 'boolean') throw new HttpError(400, 'On or off.');
      await deps.db.query('update households set cart_fallback = $2 where id = $1', [household.id, body.cartFallback]);
      sendJson(res, 200, { cartFallback: body.cartFallback });
      return true;
    }

    // Where carts go by default. Only an app this server can actually fill a
    // cart on: accepting anything else would store a preference the worker
    // has no adapter for, and the household would find out by tapping Send.
    if (body.cartVendor !== undefined) {
      const vendor = CART_VENDORS.find((v) => v === body.cartVendor);
      if (!vendor) throw new HttpError(400, 'That is not an app carts can be sent to.');
      await deps.db.query('update households set cart_vendor = $2 where id = $1', [household.id, vendor]);
      sendJson(res, 200, { cartVendor: vendor });
      return true;
    }

    const day = Number(body.billingDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new HttpError(400, 'Pick a day of the month, 1 to 31.');
    await deps.db.query('update households set billing_day = $2 where id = $1', [household.id, day]);
    sendJson(res, 200, { billingDay: day });
    return true;
  }

  if (url.pathname === '/api/households' && req.method === 'POST') {
    const userId = await requireUser(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { name?: unknown; timezone?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > HOUSEHOLD_NAME_MAX) throw new HttpError(400, `name must be 1–${HOUSEHOLD_NAME_MAX} characters`);
    if (!validTimezone(body.timezone)) throw new HttpError(400, 'timezone must be an IANA zone, e.g. Asia/Kolkata');

    const client = await deps.db.connect();
    try {
      await client.query('begin');
      const existing = await client.query('select 1 from household_members where user_id = $1', [userId]);
      if (existing.rowCount) {
        await client.query('rollback');
        throw new HttpError(409, 'you already belong to a household');
      }
      // The billing day comes back too, so a household read straight after
      // being created is the same shape as one read from /api/me. It was
      // added to the read and not to this, and the two stopped agreeing.
      const { rows } = await client.query<{ id: string; billingDay: number }>(
        'insert into households (name, timezone) values ($1, $2) returning id, billing_day as "billingDay"',
        [name, body.timezone],
      );
      await client.query(`insert into household_members (household_id, user_id, role) values ($1, $2, 'owner')`, [rows[0].id, userId]);
      await client.query('commit');
      sendJson(res, 201, { household: { id: rows[0].id, name, timezone: body.timezone, billingDay: rows[0].billingDay, role: 'owner' } });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return true;
  }

  return false;
}
