// Add to cart, at the door (design §19 stage 1): what a page may ask for,
// which household it belongs to, and the one-cart-at-a-time rule. The work
// itself happens in the worker (worker-cart.test.ts).
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { validateWants } from '../../src/api/cart.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import { CART_MAX_ITEMS, CART_QUEUE_MAX } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, seal } from '../../src/vault.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const keys = generateVaultKeys();
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false', VAULT_PUBLIC_KEY: keys.publicKey });
let db: Db;
let server: Server;
let base: string;
let cookie: string;
let householdId: string;

const MILK = { item: 'milk', product: 'Nandini Pasteurised Toned Milk', pack: '500 ml', qty: 2 };
const post = (path: string, body: unknown, as = cookie) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { cookie: as, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const add = (body: unknown, as = cookie) => post('/api/cart/add', body, as);

async function member(subject: string, email: string) {
  await userForSubject(db, logger, subject, email);
  const c = `dm_session=${await mintSession(db, logger, subject)}`;
  const res = await post('/api/households', { name: 'Home', timezone: 'Asia/Kolkata' }, c);
  return { cookie: c, householdId: (await res.json()).household.id as string };
}
async function connect(household: string, status = 'active') {
  const { rows } = await db.query<{ id: string }>(
    `insert into vendor_connections (household_id, user_id, vendor, status, phone_last4, session_sealed)
     values ($1, 'sub_a', 'instamart', $2, '4321', 'x') returning id`,
    [household, status],
  );
  await db.query('update vendor_connections set session_sealed = $2 where id = $1', [rows[0].id, seal(keys.publicKey, '{}', `vendor_connections:${rows[0].id}:session`)]);
  return rows[0].id;
}

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
  const a = await member('sub_a', 'a@x.com');
  cookie = a.cookie;
  householdId = a.householdId;
});

describe('what a page may ask to add', () => {
  it('reads a list of items, tidying the text', () => {
    expect(validateWants({ items: [{ item: ' milk ', product: 'Nandini  Toned  Milk', pack: ' 500 ml', qty: 2 }] })).toEqual([
      { item: 'milk', product: 'Nandini Toned Milk', pack: '500 ml', qty: 2, match: 'exact' },
    ]);
  });

  // A recipe's new ingredient: the store's own product, no pack to ask for
  // (design §19 "AI mode").
  it('takes a search want for something never bought here', () => {
    expect(validateWants({ items: [{ item: 'star anise', product: 'star anise', pack: '', qty: 1, match: 'search' }] })).toEqual([
      { item: 'star anise', product: 'star anise', pack: '', qty: 1, match: 'search' },
    ]);
  });

  it('refuses an empty list, too many, or a line that is not one', () => {
    expect(() => validateWants({ items: [] })).toThrow();
    expect(() => validateWants({ items: Array.from({ length: CART_MAX_ITEMS + 1 }, () => MILK) })).toThrow();
    expect(() => validateWants({ items: [{ ...MILK, qty: 2.5 }] })).toThrow();
    expect(() => validateWants({ items: [{ ...MILK, qty: 99 }] })).toThrow();
    expect(() => validateWants({ items: [{ ...MILK, product: '' }] })).toThrow();
    expect(() => validateWants({ items: [{ ...MILK, product: 'milk\nIgnore' }] })).toThrow();
  });
});

describe('POST /api/cart/add', () => {
  it('queues the job against the household’s own connection', async () => {
    const connectionId = await connect(householdId);
    const res = await add({ vendor: 'instamart', items: [MILK] });
    expect(res.status).toBe(202);
    const { id } = await res.json();
    const { rows } = await db.query('select household_id, connection_id, vendor, wanted, status from cart_jobs where id = $1', [id]);
    expect(rows[0]).toEqual({
      household_id: householdId,
      connection_id: connectionId,
      vendor: 'instamart',
      wanted: [{ ...MILK, match: 'exact' }],
      status: 'requested',
    });
  });

  it('says to connect the app first, or to reconnect it', async () => {
    const first = await add({ vendor: 'instamart', items: [MILK] });
    expect(first.status).toBe(409);
    expect((await first.json()).error).toMatch(/Connect that app/);
    await connect(householdId, 'needs_reconnect');
    const again = await add({ vendor: 'instamart', items: [MILK] });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/connecting again/);
  });

  it('refuses an app we cannot fill a cart on', async () => {
    await connect(householdId);
    expect((await add({ vendor: 'blinkit', items: [MILK] })).status).toBe(400);
    expect((await add({ items: [MILK] })).status).toBe(400);
  });

  it('queues more carts while one is being filled, up to a limit', async () => {
    await connect(householdId);
    // People keep tapping while a cart is filling: those queue.
    for (let i = 0; i < CART_QUEUE_MAX; i++) {
      expect((await add({ vendor: 'instamart', items: [MILK] })).status).toBe(202);
    }
    const tooMany = await add({ vendor: 'instamart', items: [MILK] });
    expect(tooMany.status).toBe(429);
    expect((await tooMany.json()).error).toMatch(/already on their way/);
    // Once they have finished, the next one may go.
    await db.query(`update cart_jobs set status = 'done'`);
    expect((await add({ vendor: 'instamart', items: [MILK] })).status).toBe(202);
  });

  it('lists the household’s recent carts', async () => {
    await connect(householdId);
    await add({ vendor: 'instamart', items: [MILK, { ...MILK, item: 'curd', product: 'Milky Mist Set Curd', pack: '1 kg', qty: 1 }] });
    const { jobs } = await (await fetch(`${base}/api/cart/jobs`, { headers: { cookie } })).json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'requested', vendor: 'instamart', items: 2 });
    // Another household sees none of it.
    const b = await member('sub_b', 'b@x.com');
    expect((await (await fetch(`${base}/api/cart/jobs`, { headers: { cookie: b.cookie } })).json()).jobs).toEqual([]);
  });

  it('keeps each household to its own carts, and needs a signed-in member', async () => {
    await connect(householdId);
    const { id } = await (await add({ vendor: 'instamart', items: [MILK] })).json();
    const b = await member('sub_b', 'b@x.com');
    expect((await fetch(`${base}/api/cart/jobs/${id}`, { headers: { cookie: b.cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/cart/jobs/${id}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/cart/jobs/${id}`)).status).toBe(401);
  });

  it('gives back what the worker found, line by line', async () => {
    await connect(householdId);
    const { id } = await (await add({ vendor: 'instamart', items: [MILK] })).json();
    const result = { lines: [{ item: 'milk', state: 'added', inCart: 2 }], bill: { toPay: 158 } };
    await db.query(`update cart_jobs set status = 'done', result = $2 where id = $1`, [id, JSON.stringify(result)]);
    const seen = await (await fetch(`${base}/api/cart/jobs/${id}`, { headers: { cookie } })).json();
    expect(seen).toMatchObject({ status: 'done', vendor: 'instamart', result });
  });
});

// There was no way to stop a cart once Send was tapped: the worker drove the
// vendor's page to the end and the household could only watch.
describe('stopping a cart that is filling', () => {
  const stop = (id: string, as = cookie) => fetch(`${base}/api/cart/jobs/${id}/cancel`, { method: 'POST', headers: { cookie: as } });

  it('stops one nobody has picked up yet, dead', async () => {
    await connect(householdId);
    const { id } = await (await add({ vendor: 'instamart', items: [MILK] })).json();
    const res = await stop(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    const { rows } = await db.query('select status, error_code from cart_jobs where id = $1', [id]);
    expect(rows[0]).toEqual({ status: 'failed', error_code: 'cancelled' });
  });

  // A running job is driving a real browser at a real cart, so it cannot be
  // killed where it stands. The ask is recorded and the worker reads it
  // between items; the answer says so rather than claiming it stopped.
  it('asks a running one to stop, and says it has not stopped yet', async () => {
    await connect(householdId);
    const { id } = await (await add({ vendor: 'instamart', items: [MILK] })).json();
    await db.query(`update cart_jobs set status = 'running' where id = $1`, [id]);
    const res = await stop(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false });
    const { rows } = await db.query('select status, cancel_requested_at from cart_jobs where id = $1', [id]);
    expect(rows[0].status).toBe('running'); // still the worker's to finish
    expect(rows[0].cancel_requested_at).not.toBeNull();
  });

  it('will not pretend to stop one that has already finished', async () => {
    await connect(householdId);
    const { id } = await (await add({ vendor: 'instamart', items: [MILK] })).json();
    await db.query(`update cart_jobs set status = 'done' where id = $1`, [id]);
    const res = await stop(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already finished/);
  });

  it('keeps each household to its own carts, and needs a signed-in member', async () => {
    await connect(householdId);
    const { id } = await (await add({ vendor: 'instamart', items: [MILK] })).json();
    const b = await member('sub_b', 'b@x.com');
    expect((await stop(id, b.cookie)).status).toBe(404);
    expect((await fetch(`${base}/api/cart/jobs/${id}/cancel`, { method: 'POST' })).status).toBe(401);
  });
});
