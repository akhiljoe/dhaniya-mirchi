// Households and membership (design §10.1, §14.3). Membership is the only
// thing separating two households' data, so the refusals are tested as
// carefully as the happy path.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' });
let db: Db;
let server: Server;
let base: string;

async function signedIn(subject: string, email: string | null = null): Promise<string> {
  await userForSubject(db, logger, subject, email);
  return `dm_session=${await mintSession(db, logger, subject)}`;
}

const post = (path: string, cookie: string, body: unknown, contentType = 'application/json') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

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

describe('GET /api/me', () => {
  it('is 401 without a session', async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
  });

  it('returns the user and no household before one is created', async () => {
    const cookie = await signedIn('sub_a', 'a@example.com');
    const res = await fetch(`${base}/api/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'sub_a', email: 'a@example.com', name: null, hasPicture: false, household: null, invites: [] });
  });
});

describe('POST /api/households', () => {
  it('creates a household with the creator as owner', async () => {
    const cookie = await signedIn('sub_a');
    const res = await post('/api/households', cookie, { name: 'Home', timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.household).toMatchObject({ name: 'Home', timezone: 'Asia/Kolkata', role: 'owner' });
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me.household).toEqual(body.household);
  });

  it('is 401 without a session', async () => {
    expect((await post('/api/households', '', { name: 'Home', timezone: 'Asia/Kolkata' })).status).toBe(401);
  });

  it('refuses a second household for the same user (one household per user in v1)', async () => {
    const cookie = await signedIn('sub_a');
    await post('/api/households', cookie, { name: 'Home', timezone: 'Asia/Kolkata' });
    expect((await post('/api/households', cookie, { name: 'Again', timezone: 'Asia/Kolkata' })).status).toBe(409);
  });

  it('requires a timezone, and a real IANA one — predictions are meaningless without it', async () => {
    const cookie = await signedIn('sub_a');
    expect((await post('/api/households', cookie, { name: 'Home' })).status).toBe(400);
    expect((await post('/api/households', cookie, { name: 'Home', timezone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('requires a sensible name', async () => {
    const cookie = await signedIn('sub_a');
    expect((await post('/api/households', cookie, { name: '', timezone: 'Asia/Kolkata' })).status).toBe(400);
    expect((await post('/api/households', cookie, { name: 'x'.repeat(200), timezone: 'Asia/Kolkata' })).status).toBe(400);
  });

  it('only accepts JSON — a cross-site form post cannot create anything (CSRF)', async () => {
    const cookie = await signedIn('sub_a');
    const form = await post('/api/households', cookie, 'name=Home&timezone=Asia%2FKolkata', 'application/x-www-form-urlencoded');
    expect(form.status).toBe(415);
    expect((await db.query('select count(*)::int as n from households')).rows[0].n).toBe(0);
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const cookie = await signedIn('sub_a');
    expect((await post('/api/households', cookie, '{not json')).status).toBe(400);
    expect((await post('/api/households', cookie, JSON.stringify({ name: 'a'.repeat(100_000), timezone: 'Asia/Kolkata' }))).status).toBe(413);
  });
});

describe('isolation', () => {
  it('each user sees only their own household', async () => {
    const a = await signedIn('sub_a');
    const b = await signedIn('sub_b');
    await post('/api/households', a, { name: 'A home', timezone: 'Asia/Kolkata' });
    await post('/api/households', b, { name: 'B home', timezone: 'Asia/Kolkata' });
    const meA = await (await fetch(`${base}/api/me`, { headers: { cookie: a } })).json();
    const meB = await (await fetch(`${base}/api/me`, { headers: { cookie: b } })).json();
    expect(meA.household.name).toBe('A home');
    expect(meB.household.name).toBe('B home');
    expect(meA.household.id).not.toBe(meB.household.id);
  });
});

describe('profile picture', () => {
  it('/api/me says whether there is a picture — never the provider URL', async () => {
    const cookie = await signedIn('sub_a');
    let me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me.hasPicture).toBe(false);
    await db.query(`update users set picture_url = 'https://lh3.googleusercontent.com/a/abc' where id = 'sub_a'`);
    me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me.hasPicture).toBe(true);
    expect(JSON.stringify(me)).not.toContain('googleusercontent');
  });

  it('/api/me/picture is 401 signed out and 404 when there is none', async () => {
    expect((await fetch(`${base}/api/me/picture`)).status).toBe(401);
    const cookie = await signedIn('sub_a');
    expect((await fetch(`${base}/api/me/picture`, { headers: { cookie } })).status).toBe(404);
  });

  it('/api/me/picture never fetches a stored URL on a disallowed host', async () => {
    const cookie = await signedIn('sub_a');
    // Bypass the write-side check to prove the read side refuses too.
    await db.query(`update users set picture_url = 'https://169.254.169.254/latest/meta-data' where id = 'sub_a'`);
    expect((await fetch(`${base}/api/me/picture`, { headers: { cookie } })).status).toBe(404);
  });
});

// What the pages call a person. Every screen used to show the email's local
// part; this is the name behind "Alex" instead of "owner".
describe('a person s name', () => {
  it('is null until Google or they say, and then what they said', async () => {
    const cookie = await signedIn('sub_a');
    const before = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(before.name).toBeNull();
    const res = await post('/api/me/name', cookie, { name: '  Alex  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Alex' });
    const after = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(after.name).toBe('Alex');
  });

  it('refuses a name that could not sit in a row', async () => {
    const cookie = await signedIn('sub_a');
    for (const bad of ['', '   ', 'a'.repeat(41), 'Akhil', 42]) {
      expect((await post('/api/me/name', cookie, { name: bad })).status).toBe(400);
    }
  });

  it('is 401 signed out', async () => {
    expect((await fetch(`${base}/api/me/name`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(401);
  });
});
