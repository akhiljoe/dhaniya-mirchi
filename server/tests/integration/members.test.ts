// Adding someone to a household (design §19). Membership is the only thing
// separating two households' data and grocery sessions, so who may invite,
// who may accept, and what moves with a member are tested as carefully as
// the happy path.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import { HOUSEHOLD_MAX_MEMBERS } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  AUTH_ENABLED: 'true',
  AUTH_ISSUER: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test',
  AUTH_AUTHORIZE_URL: 'https://auth.example.com/oauth2/authorize',
  AUTH_TOKEN_URL: 'https://auth.example.com/oauth2/token',
  AUTH_JWKS_URL: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test/.well-known/jwks.json',
  AUTH_CLIENT_ID: 'client_abc',
  AUTH_CLIENT_SECRET: 'secret_abc',
  AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback',
  AUTH_ALLOWED_EMAILS: 'me@gmail.com,wife@gmail.com,friend@gmail.com,a@x.com,b@x.com,c@x.com,d@x.com,e@x.com',
  AUTH_SECURE_COOKIES: 'false',
});
let db: Db;
let server: Server;
let base: string;

interface Person {
  subject: string;
  cookie: string;
  householdId: string | null;
}

async function person(subject: string, email: string, withHousehold = true): Promise<Person> {
  await userForSubject(db, logger, subject, email);
  const cookie = `dm_session=${await mintSession(db, logger, subject)}`;
  if (!withHousehold) return { subject, cookie, householdId: null };
  const res = await post('/api/households', cookie, { name: `${subject} home`, timezone: 'Asia/Kolkata' });
  return { subject, cookie, householdId: (await res.json()).household.id };
}

async function connectionWithOrders(p: Person, orderIds: string[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into vendor_connections (household_id, user_id, vendor, phone_last4, session_sealed, status)
     values ($1, $2, 'instamart', '3210', 'v1.sealed', 'active') returning id`,
    [p.householdId, p.subject],
  );
  for (const id of orderIds) {
    await db.query(
      `insert into raw_orders (household_id, connection_id, vendor, vendor_order_id, placed_at, status, total, items)
       values ($1, $2, 'instamart', $3, now() - interval '1 day', 'DELIVERED', 100, $4)`,
      [p.householdId, rows[0].id, id, JSON.stringify([{ name: 'Amul Taaza Toned Milk', sku: 'S1', storeId: 7, count: 1, pricePaid: 28 }])],
    );
  }
  await db.query(`insert into import_jobs (household_id, connection_id, vendor, status) values ($1, $2, 'instamart', 'complete')`, [
    p.householdId,
    rows[0].id,
  ]);
  return rows[0].id;
}

function post(path: string, cookie: string, body: unknown = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const get = async (path: string, cookie: string) => {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
};
const me = async (p: Person) => (await get('/api/me', p.cookie)).body;
async function invite(owner: Person, email: string): Promise<string> {
  const res = await post('/api/household/invites', owner.cookie, { email });
  expect(res.status).toBe(201);
  return (await res.json()).invite.id;
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
});

describe('inviting and joining', () => {
  it('shows the invite to the invited email only', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com', false);
    const friend = await person('sub_friend', 'friend@gmail.com', false);
    await invite(owner, 'Wife@Gmail.com');

    expect((await me(wife)).invites).toEqual([{ id: expect.any(String), householdName: 'sub_me home', invitedBy: 'me@gmail.com', members: 1 }]);
    expect((await me(friend)).invites).toEqual([]);
    expect((await me(owner)).invites).toEqual([]);
  });

  it('brings the new member in with their grocery connection and its orders, and combines the history', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    await connectionWithOrders(owner, ['M1', 'M2']);
    const wife = await person('sub_wife', 'wife@gmail.com');
    const wifeConn = await connectionWithOrders(wife, ['W1']);
    const id = await invite(owner, 'wife@gmail.com');

    const res = await post(`/api/invites/${id}/accept`, wife.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).household).toMatchObject({ id: owner.householdId, role: 'member' });

    // Her connection, orders and imports now belong to the shared household.
    const moved = await db.query(
      `select (select household_id from vendor_connections where id = $1) as conn,
              (select array_agg(distinct household_id) from raw_orders where connection_id = $1) as orders,
              (select array_agg(distinct household_id) from import_jobs where connection_id = $1) as jobs`,
      [wifeConn],
    );
    expect(moved.rows[0]).toEqual({ conn: owner.householdId, orders: [owner.householdId], jobs: [owner.householdId] });
    // Her old, now empty, household is gone.
    expect((await db.query('select 1 from households where id = $1', [wife.householdId])).rowCount).toBe(0);

    // Both see all three orders, each saying whose account it came from.
    for (const p of [owner, wife]) {
      const { body } = await get('/api/orders', p.cookie);
      expect(body.orders.map((o: { orderId: string; by: string }) => `${o.orderId}:${o.by}`).sort()).toEqual([
        'M1:me@gmail.com',
        'M2:me@gmail.com',
        'W1:wife@gmail.com',
      ]);
    }
    // The invite is used up.
    expect((await me(wife)).invites).toEqual([]);
    expect((await db.query('select 1 from household_invites')).rowCount).toBe(0);
  });

  it('lists members with the apps each connected, and pending invites', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    await connectionWithOrders(owner, []);
    const wife = await person('sub_wife', 'wife@gmail.com', false);
    await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);
    await invite(owner, 'friend@gmail.com');

    const { body } = await get('/api/household/members', wife.cookie);
    expect(body.members).toEqual([
      { userId: 'sub_me', email: 'me@gmail.com', name: null, role: 'owner', you: false, joinedAt: expect.any(String), apps: [{ vendor: 'instamart', status: 'active' }] },
      { userId: 'sub_wife', email: 'wife@gmail.com', name: null, role: 'member', you: true, joinedAt: expect.any(String), apps: [] },
    ]);
    expect(body.invites).toEqual([{ id: expect.any(String), email: 'friend@gmail.com', createdAt: expect.any(String), expiresAt: expect.any(String) }]);
  });

  it("marks which connections are the viewer's own — only they can reconnect them", async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    await connectionWithOrders(owner, ['M1']);
    const wife = await person('sub_wife', 'wife@gmail.com');
    await connectionWithOrders(wife, ['W1']);
    await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);

    const { body } = await get('/api/connections', owner.cookie);
    expect(body.connections.map((c: { memberEmail: string; mine: boolean }) => [c.memberEmail, c.mine])).toEqual([
      ['me@gmail.com', true],
      ['wife@gmail.com', false],
    ]);
  });

  it('lets someone with no household yet join, before connecting anything', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com', false);
    const res = await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);
    expect(res.status).toBe(200);
    expect((await me(wife)).household).toMatchObject({ id: owner.householdId, role: 'member' });
  });

  it('declining removes the invite and changes nothing else', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com');
    const id = await invite(owner, 'wife@gmail.com');
    expect((await post(`/api/invites/${id}/decline`, wife.cookie)).status).toBe(200);
    expect((await me(wife)).invites).toEqual([]);
    expect((await me(wife)).household.id).toBe(wife.householdId);
  });
});

describe('refusals', () => {
  it('refuses an accept from anyone but the invited email', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const friend = await person('sub_friend', 'friend@gmail.com');
    const id = await invite(owner, 'wife@gmail.com');
    expect((await post(`/api/invites/${id}/accept`, friend.cookie)).status).toBe(404);
    expect((await post(`/api/invites/${id}/decline`, friend.cookie)).status).toBe(404);
    expect((await me(friend)).household.id).toBe(friend.householdId);
    expect((await db.query('select 1 from household_invites where id = $1', [id])).rowCount).toBe(1);
  });

  it('refuses an expired invite', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com');
    const id = await invite(owner, 'wife@gmail.com');
    await db.query(`update household_invites set expires_at = now() - interval '1 minute'`);
    expect((await me(wife)).invites).toEqual([]);
    expect((await post(`/api/invites/${id}/accept`, wife.cookie)).status).toBe(404);
  });

  it('lets only the owner invite, cancel or remove', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com', false);
    await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);
    const pending = await invite(owner, 'friend@gmail.com');

    expect((await post('/api/household/invites', wife.cookie, { email: 'a@x.com' })).status).toBe(403);
    expect((await post(`/api/household/invites/${pending}/cancel`, wife.cookie)).status).toBe(403);
    expect((await post('/api/household/members/sub_me/remove', wife.cookie)).status).toBe(403);
    expect((await post(`/api/household/invites/${pending}/cancel`, owner.cookie)).status).toBe(200);
  });

  it("can't cancel another household's invite", async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const other = await person('sub_friend', 'friend@gmail.com');
    const id = await invite(owner, 'wife@gmail.com');
    expect((await post(`/api/household/invites/${id}/cancel`, other.cookie)).status).toBe(404);
  });

  it("won't invite an email that can't sign in here, or someone already in", async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const res = await post('/api/household/invites', owner.cookie, { email: 'stranger@gmail.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sign-in list/);
    expect((await post('/api/household/invites', owner.cookie, { email: 'not an email' })).status).toBe(400);
    expect((await post('/api/household/invites', owner.cookie, { email: 'me@gmail.com' })).status).toBe(409);
  });

  it(`caps a household at ${HOUSEHOLD_MAX_MEMBERS} people, counting pending invites`, async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    for (const e of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) await invite(owner, e);
    expect((await post('/api/household/invites', owner.cookie, { email: 'wife@gmail.com' })).status).toBe(409);
    // Re-sending an existing invite is not a new person.
    expect((await post('/api/household/invites', owner.cookie, { email: 'a@x.com' })).status).toBe(201);
  });

  it("won't move someone mid-connect: the attempt is saved to the household it started in", async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com');
    await db.query(
      `insert into connect_requests (id, household_id, user_id, vendor, phone_last4, status, expires_at)
       values (gen_random_uuid(), $1, 'sub_wife', 'instamart', '1234', 'otp_sent', now() + interval '5 minutes')`,
      [wife.householdId],
    );
    const res = await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);
    expect(res.status).toBe(409);
    expect((await me(wife)).household.id).toBe(wife.householdId);
  });

  it('keeps an owner whose household has others from walking out on them', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com', false);
    await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);
    const friend = await person('sub_friend', 'friend@gmail.com');
    const id = await invite(friend, 'me@gmail.com');
    expect((await post(`/api/invites/${id}/accept`, owner.cookie)).status).toBe(409);
    expect((await post('/api/household/leave', owner.cookie)).status).toBe(409);
  });
});

describe('leaving and removing', () => {
  it('a removed member leaves with their own connection and orders, into a household of their own', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    await connectionWithOrders(owner, ['M1']);
    const wife = await person('sub_wife', 'wife@gmail.com');
    await connectionWithOrders(wife, ['W1']);
    await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);

    expect((await post('/api/household/members/sub_wife/remove', owner.cookie)).status).toBe(200);
    const hers = (await me(wife)).household;
    expect(hers).toMatchObject({ name: 'Home', timezone: 'Asia/Kolkata', role: 'owner' });
    expect(hers.id).not.toBe(owner.householdId);
    expect((await get('/api/orders', owner.cookie)).body.orders.map((o: { orderId: string }) => o.orderId)).toEqual(['M1']);
    expect((await get('/api/orders', wife.cookie)).body.orders.map((o: { orderId: string }) => o.orderId)).toEqual(['W1']);
  });

  it('a member can leave; the owner cannot remove themselves', async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    const wife = await person('sub_wife', 'wife@gmail.com', false);
    await post(`/api/invites/${await invite(owner, 'wife@gmail.com')}/accept`, wife.cookie);

    expect((await post('/api/household/members/sub_me/remove', owner.cookie)).status).toBe(400);
    const res = await post('/api/household/leave', wife.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).household).toMatchObject({ role: 'owner' });
    expect((await get('/api/household/members', owner.cookie)).body.members).toHaveLength(1);
  });

  it("can't remove someone from another household", async () => {
    const owner = await person('sub_me', 'me@gmail.com');
    await person('sub_friend', 'friend@gmail.com');
    expect((await post('/api/household/members/sub_friend/remove', owner.cookie)).status).toBe(404);
  });
});
