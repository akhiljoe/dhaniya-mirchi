// Households are linked by verified email: the same person signing in under a
// new account (a different Cognito user for the same Google login) lands in
// their household instead of an empty new one. Only a verified email counts —
// an unverified one would let anyone who typed your address into your home.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import type { OidcClient, StartedFlow } from '../../src/auth/oidc.js';
import { userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
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
  AUTH_ALLOWED_EMAILS: 'me@gmail.com,someone@gmail.com',
  AUTH_SECURE_COOKIES: 'false',
});
let db: Db;
let server: Server;
let base: string;
// Who the provider says is signing in next.
let identity = { subject: 'sub_new', email: null as string | null, picture: null, givenName: null };
const flow: StartedFlow = {
  authorizeUrl: 'https://auth.example.com/oauth2/authorize?state=S',
  state: 'STATE_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  nonce: 'NONCE_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  codeVerifier: 'VERIFIER_abcdefghijklmnopqrstuvwxyz0123456789',
};
const oidc: OidcClient = { start: () => flow, exchange: async () => identity };

// A full sign-in; returns the new session cookie (empty when refused).
async function signIn(subject: string, email: string | null): Promise<string> {
  identity = { subject, email, picture: null, givenName: null };
  const start = await fetch(`${base}/auth/start`, { redirect: 'manual' });
  const flowCookie = start.headers.getSetCookie().find((c) => c.startsWith('dm_flow='))!.split(';')[0];
  // A fresh code each time: one client and one state serve every test here,
  // and a repeat of the same callback gets the first one's result.
  const cb = await fetch(`${base}/auth/callback?code=${subject}_${Date.now()}&state=${flow.state}`, { redirect: 'manual', headers: { cookie: flowCookie } });
  return cb.headers.getSetCookie().find((c) => c.startsWith('dm_session='))?.split(';')[0] ?? '';
}

async function withHousehold(subject: string, email: string | null, name: string): Promise<string> {
  await userForSubject(db, logger, subject, email);
  const id = (await db.query<{ id: string }>(`insert into households (name, timezone) values ($1, 'Asia/Kolkata') returning id`, [name])).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, $2, 'owner')`, [id, subject]);
  return id;
}

const householdOf = async (cookie: string) =>
  ((await (await fetch(`${base}/api/me`, { headers: { cookie } })).json()) as { household: { id: string; role: string } | null }).household;

beforeAll(async () => {
  db = await freshTestDb();
  server = createServer(createApp({ config, logger, db, oidc }));
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

describe('linking households by verified email', () => {
  it("puts a new account with the same verified email into that person's household", async () => {
    const home = await withHousehold('sub_old', 'me@gmail.com', 'Home');
    const cookie = await signIn('sub_new', 'Me@Gmail.com'); // case doesn't matter
    expect(await householdOf(cookie)).toMatchObject({ id: home, role: 'owner' });
  });

  it('never lets an account without a verified email in, so it can never link', async () => {
    await withHousehold('sub_old', 'me@gmail.com', 'Home');
    expect(await signIn('sub_new', null)).toBe('');
    const { rows } = await db.query(`select 1 from household_members where user_id = 'sub_new'`);
    expect(rows).toEqual([]);
  });

  it('never links different people', async () => {
    await withHousehold('sub_old', 'me@gmail.com', 'Home');
    expect(await householdOf(await signIn('sub_new', 'someone@gmail.com'))).toBeNull();
  });

  it('leaves an account that already has a household where it is', async () => {
    await withHousehold('sub_old', 'me@gmail.com', 'Home');
    const own = await withHousehold('sub_new', null, 'Flat');
    expect(await householdOf(await signIn('sub_new', 'me@gmail.com'))).toMatchObject({ id: own });
  });
});
