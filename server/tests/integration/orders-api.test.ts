// The household's orders, for the browser's engine (design §7.6, §9). Line
// items with their catalog pack label; never an address, phone or name.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import { VENDOR_HISTORY_DAYS } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' });
let db: Db;
let server: Server;
let base: string;

async function member(subject: string): Promise<{ cookie: string; householdId: string }> {
  await userForSubject(db, logger, subject, null);
  const cookie = `dm_session=${await mintSession(db, logger, subject)}`;
  const res = await fetch(`${base}/api/households`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${subject} home`, timezone: 'Asia/Kolkata' }),
  });
  return { cookie, householdId: (await res.json()).household.id };
}

async function connection(householdId: string, userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into vendor_connections (household_id, user_id, vendor, phone_last4, session_sealed, status)
     values ($1, $2, 'instamart', '3210', 'v1.sealed', 'active') returning id`,
    [householdId, userId],
  );
  return rows[0].id;
}

async function order(householdId: string, connectionId: string, id: string, placedAt: string, status: string, items: unknown[]) {
  await db.query(
    `insert into raw_orders (household_id, connection_id, vendor, vendor_order_id, placed_at, status, total, address_label, address_ref, items)
     values ($1, $2, 'instamart', $3, $4, $5, 250, 'Home', 'ref123', $6)`,
    [householdId, connectionId, id, placedAt, status, JSON.stringify(items)],
  );
}

const milk = { name: 'Amul Taaza Toned Milk', sku: 'S1', storeId: 7, count: 2, pricePaid: 56 };
const coriander = { name: 'Coriander Leaves', sku: 'S2', storeId: 7, count: 1, pricePaid: 12 };

const orders = async (cookie: string) => {
  const res = await fetch(`${base}/api/orders`, { headers: { cookie } });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

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
  await db.query('truncate users, households, sku_packs cascade');
});

describe('GET /api/orders', () => {
  it("returns the household's delivered orders and those on their way, newest first, never failed or cancelled ones", async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await order(a.householdId, conn, 'O1', '2026-09-01T09:00:00Z', 'DELIVERED', [milk, coriander]);
    await order(a.householdId, conn, 'O2', '2026-09-05T09:00:00Z', 'DELIVERED', [milk]);
    await order(a.householdId, conn, 'O3', '2026-09-06T09:00:00Z', 'CANCELLED', [milk]);
    await order(a.householdId, conn, 'O4', '2026-09-07T09:00:00Z', 'FAILED', [milk]);
    await order(a.householdId, conn, 'O5', '2026-09-08T09:00:00Z', 'ACTIVE', [milk]);
    await db.query(`insert into sku_packs (vendor, store_id, sku, label) values ('instamart', 7, 'S1', '500 ml'), ('instamart', 7, 'S2', null)`);

    const { body } = await orders(a.cookie);
    expect(body.orders.map((o: { orderId: string; status: string }) => `${o.orderId}:${o.status}`)).toEqual(['O5:ACTIVE', 'O2:DELIVERED', 'O1:DELIVERED']);
    expect(body.orders[2]).toEqual({
      vendor: 'instamart',
      orderId: 'O1',
      placedAt: '2026-09-01T09:00:00.000Z',
      status: 'DELIVERED',
      total: 250,
      addressLabel: 'Home',
      by: null, // the connection's member has no email in this test
      byName: null,
      items: [
        { name: 'Amul Taaza Toned Milk', count: 2, pricePaid: 56, packLabel: '500 ml', prepared: null },
        { name: 'Coriander Leaves', count: 1, pricePaid: 12, packLabel: null, prepared: null }, // looked up, not in the catalog
      ],
    });
  });

  it('gives a pack not yet looked up as null — the browser treats it as unknown, never guessed', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await order(a.householdId, conn, 'O1', '2026-09-01T09:00:00Z', 'DELIVERED', [milk]);
    const { body } = await orders(a.cookie);
    expect(body.orders[0].items[0].packLabel).toBeNull();
  });

  it("says how far back each connected app's history reaches", async () => {
    const a = await member('sub_a');
    await connection(a.householdId, 'sub_a');
    const before = Date.now();
    const { body } = await orders(a.cookie);
    expect(body.coverage).toHaveLength(1);
    expect(body.coverage[0].vendor).toBe('instamart');
    const start = new Date(body.coverage[0].coverageStart).getTime();
    const expected = before - VENDOR_HISTORY_DAYS.instamart! * 86_400_000;
    expect(Math.abs(start - expected)).toBeLessThan(60_000);
  });

  it('never returns the address reference, and never another household\'s orders', async () => {
    const a = await member('sub_a');
    const b = await member('sub_b');
    await order(b.householdId, await connection(b.householdId, 'sub_b'), 'OB', '2026-09-01T09:00:00Z', 'DELIVERED', [milk]);
    const conn = await connection(a.householdId, 'sub_a');
    await order(a.householdId, conn, 'OA', '2026-09-01T09:00:00Z', 'DELIVERED', [milk]);
    const { body } = await orders(a.cookie);
    expect(body.orders.map((o: { orderId: string }) => o.orderId)).toEqual(['OA']);
    expect(JSON.stringify(body)).not.toContain('ref123');
    expect(JSON.stringify(body)).not.toContain('sku');
  });

  it('counts an order once when two members connected the same grocery account', async () => {
    const a = await member('sub_a');
    await userForSubject(db, logger, 'sub_b', null);
    await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_b', 'member')`, [a.householdId]);
    const mine = await connection(a.householdId, 'sub_a');
    const theirs = await connection(a.householdId, 'sub_b');
    await order(a.householdId, mine, 'O1', '2026-09-01T09:00:00Z', 'DELIVERED', [milk]);
    await order(a.householdId, theirs, 'O1', '2026-09-01T09:00:00Z', 'DELIVERED', [milk]);
    await order(a.householdId, theirs, 'O2', '2026-09-03T09:00:00Z', 'DELIVERED', [milk]);
    const { body } = await orders(a.cookie);
    expect(body.orders.map((o: { orderId: string }) => o.orderId)).toEqual(['O2', 'O1']);
    expect(body.coverage).toHaveLength(1);
  });

  it('is 401 signed out and 403 without a household', async () => {
    expect((await orders('')).status).toBe(401);
    await userForSubject(db, logger, 'sub_lone', null);
    expect((await orders(`dm_session=${await mintSession(db, logger, 'sub_lone')}`)).status).toBe(403);
  });
});
