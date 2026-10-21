// Import progress (design §7.10): the page polls this so the user can leave
// and come back — progress lives on the server, never in the tab.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import { IMPORT_CALL_DELAY_MS } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' });
let db: Db;
let server: Server;
let base: string;

// A signed-in user with a household; returns the cookie and household id.
async function member(subject: string): Promise<{ cookie: string; householdId: string }> {
  await userForSubject(db, logger, subject, null);
  const cookie = `dm_session=${await mintSession(db, logger, subject)}`;
  const res = await fetch(`${base}/api/households`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${subject} home`, timezone: 'Asia/Kolkata' }),
  });
  const { household } = await res.json();
  return { cookie, householdId: household.id };
}

async function connection(householdId: string, userId: string, vendor = 'instamart'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into vendor_connections (household_id, user_id, vendor, phone_last4, session_sealed, status)
     values ($1, $2, $3, '3210', 'v1.sealed-session', 'active') returning id`,
    [householdId, userId, vendor],
  );
  return rows[0].id;
}

async function job(connectionId: string, fields: Record<string, unknown>, createdAgoSeconds = 0): Promise<void> {
  const cols = ['household_id', 'connection_id', 'vendor', 'created_at', ...Object.keys(fields)];
  const values = Object.values(fields);
  await db.query(
    `insert into import_jobs (${cols.join(', ')})
     select household_id, id, vendor, now() - make_interval(secs => $2), ${values.map((_, i) => `$${i + 3}`).join(', ')}
       from vendor_connections where id = $1`,
    [connectionId, createdAgoSeconds, ...values],
  );
}

const imports = async (cookie: string) => {
  const res = await fetch(`${base}/api/imports`, { headers: { cookie } });
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
  await db.query('truncate users, households cascade');
});

describe('GET /api/imports', () => {
  it("shows the latest import of each of the household's connections — and only theirs", async () => {
    const a = await member('sub_a');
    const b = await member('sub_b');
    const conn = await connection(a.householdId, 'sub_a');
    await job(conn, { status: 'complete', orders_done: 100 }, 3600); // an older run
    await job(conn, { status: 'listing', orders_done: 40 });
    await job(await connection(b.householdId, 'sub_b'), { status: 'listing', orders_done: 7 });

    const { body } = await imports(a.cookie);
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]).toMatchObject({ vendor: 'instamart', status: 'listing', ordersDone: 40 });
    expect(JSON.stringify(body)).not.toContain('sealed');
  });

  it('has no estimate before any order is read', async () => {
    const a = await member('sub_a');
    await job(await connection(a.householdId, 'sub_a'), { status: 'listing', orders_done: 0 });
    const [imp] = (await imports(a.cookie)).body.imports;
    expect(imp.estimate).toEqual({ readyAt: null, completeAt: null, stillCounting: true });
  });

  it('while orders are read, estimates from the products they need that nobody has looked up yet', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    const line = (sku: string) => ({ name: sku, sku, storeId: 7, count: 1, pricePaid: 10 });
    const orders: [string, string[]][] = [
      ['O1', ['S1', 'S2']],
      ['O2', ['S2', 'S3']],
    ];
    for (const [id, skus] of orders) {
      await db.query(
        `insert into raw_orders (household_id, connection_id, vendor, vendor_order_id, placed_at, status, items)
         values ($1, $2, 'instamart', $3, now(), 'DELIVERED', $4)`,
        [a.householdId, conn, id, JSON.stringify(skus.map(line))],
      );
    }
    await db.query(`insert into sku_packs (vendor, store_id, sku, label) values ('instamart', 7, 'S3', '1 kg')`); // already known
    // The last import that timed its lookups (another household's): 1 s each.
    const other = await member('sub_b');
    await job(await connection(other.householdId, 'sub_b'), { status: 'complete', step_ms: [1_000, 1_000] }, 60);
    await job(conn, { status: 'listing', orders_done: 2 });

    const before = Date.now();
    const [imp] = (await imports(a.cookie)).body.imports;
    expect(imp.estimate.stillCounting).toBe(true);
    const left = new Date(imp.estimate.completeAt).getTime() - before;
    const expected = 2 * (1_000 + IMPORT_CALL_DELAY_MS); // S1 and S2
    expect(left).toBeGreaterThan(expected - 5_000);
    expect(left).toBeLessThan(expected + 5_000);
  });

  it('says whether a run reads the history or syncs new orders', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await job(conn, { status: 'listing' });
    expect((await imports(a.cookie)).body.imports[0].kind).toBe('first');
    await db.query(`update import_jobs set status = 'complete', orders_done = 260`);
    await job(conn, { status: 'complete', orders_done: 0 }, -60);
    expect((await imports(a.cookie)).body.imports[0]).toMatchObject({ kind: 'sync', ordersDone: 0 });
  });

  it('estimates from the measured pace once the work is known', async () => {
    const a = await member('sub_a');
    // 300 packs, 100 done, recent lookups ~2 s each → ~400 s to go.
    await job(await connection(a.householdId, 'sub_a'), {
      status: 'packs',
      orders_done: 250,
      skus_total: 300,
      skus_done: 100,
      step_ms: [1_900, 2_100, 2_000],
      ready_at: new Date(),
    });
    const before = Date.now();
    const [imp] = (await imports(a.cookie)).body.imports;
    expect(imp).toMatchObject({ status: 'packs', skusTotal: 300, skusDone: 100 });
    expect(imp.readyAt).not.toBeNull();
    const left = new Date(imp.estimate.completeAt).getTime() - before;
    const expected = 200 * (2_000 + IMPORT_CALL_DELAY_MS); // the pause after each lookup counts
    expect(left).toBeGreaterThan(expected - 10_000);
    expect(left).toBeLessThan(expected + 10_000);
    expect(imp.estimate.stillCounting).toBe(false);
  });

  it('has no estimate once the import has ended', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await job(conn, { status: 'complete', orders_done: 256, skus_total: 600, skus_done: 600, completed_at: new Date(), ready_at: new Date() });
    const [imp] = (await imports(a.cookie)).body.imports;
    expect(imp.status).toBe('complete');
    expect(imp.completedAt).not.toBeNull();
    expect(imp.estimate).toBeNull();
  });

  it('reports a vendor that needs reconnecting, with a code the page can explain', async () => {
    const a = await member('sub_a');
    await job(await connection(a.householdId, 'sub_a'), { status: 'needs_reconnect', error_code: 'unauthorized' });
    const [imp] = (await imports(a.cookie)).body.imports;
    expect(imp).toMatchObject({ status: 'needs_reconnect', errorCode: 'unauthorized', estimate: null });
  });

  it('is empty for a household with nothing connected', async () => {
    const a = await member('sub_a');
    expect((await imports(a.cookie)).body).toEqual({ imports: [] });
  });

  it('is 401 signed out and 403 without a household', async () => {
    expect((await imports('')).status).toBe(401);
    await userForSubject(db, logger, 'sub_lone', null);
    expect((await imports(`dm_session=${await mintSession(db, logger, 'sub_lone')}`)).status).toBe(403);
  });
});

describe('POST /api/imports/:vendor/retry', () => {
  const retry = (cookie: string, vendor = 'instamart') =>
    fetch(`${base}/api/imports/${vendor}/retry`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  const jobsOf = async (connectionId: string) =>
    (await db.query(`select status from import_jobs where connection_id = $1 order by created_at`, [connectionId])).rows.map((r) => r.status);

  it('queues a stopped import again — it continues where it stopped', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await job(conn, { status: 'failed', error_code: 'unreachable' }, 60);
    const res = await retry(a.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });
    expect(await jobsOf(conn)).toEqual(['failed', 'queued']);
  });

  it('never starts a second run beside a live one', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await job(conn, { status: 'packs' });
    expect((await retry(a.cookie)).status).toBe(200);
    expect(await jobsOf(conn)).toEqual(['packs']);
  });

  it('asks for a reconnect when the vendor no longer accepts the session', async () => {
    const a = await member('sub_a');
    const conn = await connection(a.householdId, 'sub_a');
    await db.query(`update vendor_connections set status = 'needs_reconnect' where id = $1`, [conn]);
    expect((await retry(a.cookie)).status).toBe(409);
    expect(await jobsOf(conn)).toEqual([]);
  });

  it("is 404 without a connection to that app, and never touches another household's", async () => {
    const a = await member('sub_a');
    const b = await member('sub_b');
    const theirs = await connection(b.householdId, 'sub_b');
    expect((await retry(a.cookie)).status).toBe(404);
    expect(await jobsOf(theirs)).toEqual([]);
  });

  it('is 401 signed out', async () => {
    expect((await retry('')).status).toBe(401);
  });
});
