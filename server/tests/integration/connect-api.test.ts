// The connect api (design §7.10): the user types phone and OTP on our page;
// the api seals them for the worker and never holds a way to read them back.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, openSealed } from '../../src/vault.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const keys = generateVaultKeys();
// The api gets the public key ONLY — exactly as in production.
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false', VAULT_PUBLIC_KEY: keys.publicKey });
let db: Db;
let server: Server;
let base: string;

async function member(subject: string): Promise<string> {
  await userForSubject(db, logger, subject, null);
  const cookie = `dm_session=${await mintSession(db, logger, subject)}`;
  await fetch(`${base}/api/households`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${subject} home`, timezone: 'Asia/Kolkata' }),
  });
  return cookie;
}

const post = (path: string, cookie: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie } });

beforeAll(async () => {
  db = await freshTestDb();
  server = createServer(createApp({ config, logger, db, oidc: null }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
});

describe('POST /api/connect/:vendor', () => {
  it('queues a request with the phone sealed — never stored readable', async () => {
    const cookie = await member('sub_a');
    const res = await post('/api/connect/instamart', cookie, { phone: '9876543210' });
    expect(res.status).toBe(202);
    const { id, status } = await res.json();
    expect(status).toBe('requested');

    const { rows } = await db.query('select * from connect_requests where id = $1', [id]);
    const row = rows[0];
    expect(row.phone_last4).toBe('3210');
    expect(JSON.stringify(row)).not.toContain('9876543210');
    // Only the worker's private key opens it, and only in this row's context.
    expect(openSealed([keys.privateKey], row.phone_sealed, `connect_requests:${id}:phone`)).toBe('9876543210');
  });

  it('is 401 signed out and 403 without a household', async () => {
    expect((await post('/api/connect/instamart', '', { phone: '9876543210' })).status).toBe(401);
    await userForSubject(db, logger, 'sub_lone', null);
    const lone = `dm_session=${await mintSession(db, logger, 'sub_lone')}`;
    expect((await post('/api/connect/instamart', lone, { phone: '9876543210' })).status).toBe(403);
  });

  it('accepts a 10-digit Indian mobile only', async () => {
    const cookie = await member('sub_a');
    for (const phone of ['12345', '0876543210', '98765432101', 'abcdefghij', '']) {
      expect((await post('/api/connect/instamart', cookie, { phone })).status).toBe(400);
    }
    expect((await post('/api/connect/instamart', cookie, { phone: '+91 98765 43210' })).status).toBe(202);
  });

  it('refuses a vendor that has no connect adapter yet', async () => {
    const cookie = await member('sub_a');
    expect((await post('/api/connect/bigbasket', cookie, { phone: '9876543210' })).status).toBe(400);
    expect((await post('/api/connect/amazon', cookie, { phone: '9876543210' })).status).toBe(400);
  });

  it('accepts Zepto, whose connect adapter drives its own login form (design Appendix D)', async () => {
    const cookie = await member('sub_a');
    expect((await post('/api/connect/zepto', cookie, { phone: '9876543210' })).status).toBe(202);
  });

  it('allows one in-flight request per user and vendor', async () => {
    const cookie = await member('sub_a');
    expect((await post('/api/connect/instamart', cookie, { phone: '9876543210' })).status).toBe(202);
    expect((await post('/api/connect/instamart', cookie, { phone: '9876543210' })).status).toBe(409);
  });

  it('is 503 when the server has no vault key', async () => {
    const noVault = createServer(
      createApp({ config: loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' }), logger, db, oidc: null }),
    );
    await new Promise<void>((r) => noVault.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(noVault.address() as AddressInfo).port}`;
    const cookie = await member('sub_a');
    const res = await fetch(`${b}/api/connect/instamart`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '9876543210' }),
    });
    expect(res.status).toBe(503);
    await new Promise<void>((r) => noVault.close(() => r()));
  });
});

describe('GET /api/connect/requests/:id', () => {
  it('reports status, and only to the household that made it', async () => {
    const a = await member('sub_a');
    const b = await member('sub_b');
    const { id } = await (await post('/api/connect/instamart', a, { phone: '9876543210' })).json();
    const mine = await get(`/api/connect/requests/${id}`, a);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ id, vendor: 'instamart', status: 'requested', phoneLast4: '3210' });
    expect((await get(`/api/connect/requests/${id}`, b)).status).toBe(404);
    expect((await get(`/api/connect/requests/not-a-uuid`, a)).status).toBe(404);
  });
});

describe('POST /api/connect/requests/:id/otp', () => {
  async function awaitingOtp(cookie: string): Promise<string> {
    const { id } = await (await post('/api/connect/instamart', cookie, { phone: '9876543210' })).json();
    await db.query(`update connect_requests set status = 'otp_sent' where id = $1`, [id]); // as the worker would
    return id;
  }

  it('seals the OTP for the worker and moves to verifying', async () => {
    const cookie = await member('sub_a');
    const id = await awaitingOtp(cookie);
    const res = await post(`/api/connect/requests/${id}/otp`, cookie, { otp: '4821' });
    expect(res.status).toBe(202);
    const { rows } = await db.query('select status, otp_sealed from connect_requests where id = $1', [id]);
    expect(rows[0].status).toBe('verifying');
    expect(rows[0].otp_sealed).not.toContain('4821');
    expect(openSealed([keys.privateKey], rows[0].otp_sealed, `connect_requests:${id}:otp`)).toBe('4821');
  });

  it('only accepts an OTP while one is awaited', async () => {
    const cookie = await member('sub_a');
    const { id } = await (await post('/api/connect/instamart', cookie, { phone: '9876543210' })).json();
    expect((await post(`/api/connect/requests/${id}/otp`, cookie, { otp: '4821' })).status).toBe(409);
  });

  it('accepts 4–6 digits only', async () => {
    const cookie = await member('sub_a');
    const id = await awaitingOtp(cookie);
    for (const otp of ['12', '1234567', 'abcd', '']) {
      expect((await post(`/api/connect/requests/${id}/otp`, cookie, { otp })).status).toBe(400);
    }
  });

  it("can't submit to another household's request", async () => {
    const a = await member('sub_a');
    const b = await member('sub_b');
    const id = await awaitingOtp(a);
    expect((await post(`/api/connect/requests/${id}/otp`, b, { otp: '4821' })).status).toBe(404);
  });
});

describe('GET /api/connections', () => {
  it("lists the household's connections without any session material", async () => {
    const cookie = await member('sub_a');
    const { rows } = await db.query<{ household_id: string }>(
      `select household_id from household_members where user_id = 'sub_a'`,
    );
    await db.query(
      `insert into vendor_connections (household_id, user_id, vendor, phone_last4, session_sealed, status)
       values ($1, 'sub_a', 'instamart', '3210', 'v1.sealed', 'active')`,
      [rows[0].household_id],
    );
    const body = await (await get('/api/connections', cookie)).json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ vendor: 'instamart', phoneLast4: '3210', status: 'active' });
    expect(JSON.stringify(body)).not.toContain('sealed');
  });

  it('says what each connection holds and when it synced', async () => {
    const cookie = await member('sub_a');
    const hh = (await db.query<{ household_id: string }>(`select household_id from household_members where user_id = 'sub_a'`)).rows[0].household_id;
    const conn = (
      await db.query<{ id: string }>(
        `insert into vendor_connections (household_id, user_id, vendor, phone_last4, session_sealed, status)
         values ($1, 'sub_a', 'instamart', '3210', 'v1.sealed', 'active') returning id`,
        [hh],
      )
    ).rows[0].id;
    for (const [id, at, status] of [['O1', '2025-10-01T08:00:00Z', 'DELIVERED'], ['O2', '2026-09-10T08:00:00Z', 'DELIVERED'], ['O3', '2026-09-12T08:00:00Z', 'CANCELLED']]) {
      await db.query(
        `insert into raw_orders (household_id, connection_id, vendor, vendor_order_id, placed_at, status, items) values ($1, $2, 'instamart', $3, $4, $5, '[]')`,
        [hh, conn, id, at, status],
      );
    }
    // Two syncs: the first import, then a later one that found 1 new order.
    await db.query(
      `insert into import_jobs (household_id, connection_id, vendor, status, orders_done, created_at, completed_at)
       values ($1, $2, 'instamart', 'complete', 250, '2026-09-18T10:00:00Z', '2026-09-18T10:40:00Z'),
              ($1, $2, 'instamart', 'complete', 1, '2026-09-19T09:00:00Z', '2026-09-19T09:01:00Z')`,
      [hh, conn],
    );
    const [c] = (await (await get('/api/connections', cookie)).json()).connections;
    expect(c).toMatchObject({
      orders: 2, // delivered only
      firstOrderAt: '2025-10-01T08:00:00.000Z',
      lastOrderAt: '2026-09-10T08:00:00.000Z',
    });
    expect(c.syncs).toEqual([
      { startedAt: '2026-09-19T09:00:00.000Z', completedAt: '2026-09-19T09:01:00.000Z', status: 'complete', ordersAdded: 1 },
      { startedAt: '2026-09-18T10:00:00.000Z', completedAt: '2026-09-18T10:40:00.000Z', status: 'complete', ordersAdded: 250 },
    ]);
  });
});

describe('POST /api/connect/:vendor/cancel', () => {
  const start = async (cookie: string) => (await (await post('/api/connect/instamart', cookie, { phone: '9876543210' })).json()).id as string;

  it("ends the user's attempt, clears the sealed phone, and frees the slot for a new one", async () => {
    const cookie = await member('sub_a');
    const id = await start(cookie);
    const res = await post('/api/connect/instamart/cancel', cookie, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });

    const { rows } = await db.query('select status, phone_sealed, otp_sealed from connect_requests where id = $1', [id]);
    expect(rows[0]).toEqual({ status: 'cancelled', phone_sealed: null, otp_sealed: null });
    // The wrong number can be replaced straight away — no "already in progress".
    expect((await post('/api/connect/instamart', cookie, { phone: '9876500000' })).status).toBe(202);
  });

  it('cancels while the code is awaited, clearing any sealed code', async () => {
    const cookie = await member('sub_a');
    const id = await start(cookie);
    await db.query(`update connect_requests set status = 'otp_sent', otp_sealed = 'v1.x' where id = $1`, [id]); // as the worker would
    expect(await (await post('/api/connect/instamart/cancel', cookie, {})).json()).toEqual({ cancelled: true });
    const { rows } = await db.query('select status, otp_sealed from connect_requests where id = $1', [id]);
    expect(rows[0]).toEqual({ status: 'cancelled', otp_sealed: null });
  });

  it('is a no-op when nothing is in flight', async () => {
    const cookie = await member('sub_a');
    const res = await post('/api/connect/instamart/cancel', cookie, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: false });
  });

  it("never touches another user's attempt", async () => {
    const a = await member('sub_a');
    const b = await member('sub_b');
    const id = await start(a);
    expect(await (await post('/api/connect/instamart/cancel', b, {})).json()).toEqual({ cancelled: false });
    const { rows } = await db.query('select status from connect_requests where id = $1', [id]);
    expect(rows[0].status).toBe('requested');
  });

  it('refuses while a typed code is being checked — the result is seconds away', async () => {
    const cookie = await member('sub_a');
    const id = await start(cookie);
    await db.query(`update connect_requests set status = 'verifying' where id = $1`, [id]);
    expect((await post('/api/connect/instamart/cancel', cookie, {})).status).toBe(409);
    const { rows } = await db.query('select status from connect_requests where id = $1', [id]);
    expect(rows[0].status).toBe('verifying');
  });

  it('is 401 signed out and 400 for an unknown vendor', async () => {
    expect((await post('/api/connect/instamart/cancel', '', {})).status).toBe(401);
    const cookie = await member('sub_a');
    expect((await post('/api/connect/amazon/cancel', cookie, {})).status).toBe(400);
  });
});

// Where a household's carts are filled (design §19 stage 1): Instamart keeps
// a cart per store, and the store follows from the delivery address, so the
// household picks one of the addresses saved in its own app.
describe('the address a cart is filled for', () => {
  const MAPLE = { id: 'addr-maple', label: 'Maple Residency', display: 'Maple, Example Layout', lat: 12.97, lng: 77.59, name: 'A HOUSEHOLD' };
  const OFFICE = { id: 'addr-office', label: 'Tech Park', display: 'Tech Park bus stop', lat: 12.93, lng: 77.62, name: 'A HOUSEHOLD' };

  const householdOf = async (subject: string) =>
    (await db.query<{ household_id: string }>('select household_id from household_members where user_id = $1', [subject])).rows[0].household_id;

  async function connectionWithAddresses(householdId: string, addresses: unknown[], chosen: unknown = null) {
    const { rows } = await db.query<{ id: string }>(
      `insert into vendor_connections (household_id, user_id, vendor, status, phone_last4, session_sealed, addresses, cart_address)
       values ($1, (select user_id from household_members where household_id = $1 limit 1), 'instamart', 'active', '4321', 'sealed', $2, $3) returning id`,
      [householdId, JSON.stringify(addresses), chosen ? JSON.stringify(chosen) : null],
    );
    return rows[0].id;
  }

  it('lists the app’s own addresses, and the one picked', async () => {
    const cookie = await member('sub_a');
    await connectionWithAddresses(await householdOf('sub_a'), [MAPLE, OFFICE], MAPLE);
    const { connections } = await (await get('/api/connections', cookie)).json();
    expect(connections[0].addresses).toEqual([
      { id: 'addr-maple', label: 'Maple Residency', display: 'Maple, Example Layout' },
      { id: 'addr-office', label: 'Tech Park', display: 'Tech Park bus stop' },
    ]);
    expect(connections[0].cartAddress).toEqual({ id: 'addr-maple', label: 'Maple Residency', chosenByHousehold: false });
    // Nothing about the account's own name or phone leaves the server.
    expect(JSON.stringify(connections)).not.toContain('A HOUSEHOLD');
  });

  it('says when the address is only our guess, so the page can ask', async () => {
    const cookie = await member('sub_a');
    // What a cart job stores before anyone has picked: matched from where
    // the household's orders go.
    await connectionWithAddresses(await householdOf('sub_a'), [MAPLE, OFFICE], { ...MAPLE, chosenByHousehold: false });
    const { connections } = await (await get('/api/connections', cookie)).json();
    expect(connections[0].cartAddress).toEqual({ id: 'addr-maple', label: 'Maple Residency', chosenByHousehold: false });
  });

  it('saves the household’s choice', async () => {
    const cookie = await member('sub_a');
    const id = await connectionWithAddresses(await householdOf('sub_a'), [MAPLE, OFFICE]);
    const res = await post(`/api/connections/${id}/address`, cookie, { addressId: 'addr-office' });
    expect(res.status).toBe(200);
    const { connections } = await (await get('/api/connections', cookie)).json();
    // Chosen by the household: the page stops asking.
    expect(connections[0].cartAddress).toEqual({ id: 'addr-office', label: 'Tech Park', chosenByHousehold: true });
  });

  it('refuses an address the app does not have, and another household’s app', async () => {
    const cookie = await member('sub_a');
    const id = await connectionWithAddresses(await householdOf('sub_a'), [MAPLE]);
    expect((await post(`/api/connections/${id}/address`, cookie, { addressId: 'addr-somewhere' })).status).toBe(400);
    const other = await member('sub_b');
    expect((await post(`/api/connections/${id}/address`, other, { addressId: 'addr-maple' })).status).toBe(404);
  });
});
