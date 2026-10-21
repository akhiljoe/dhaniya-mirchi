// Turning notifications on (design §13.1): the browser subscribes with our
// public key and hands us its push endpoint. The endpoint is a capability —
// it is stored for the worker and never sent back to any page.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const vapid = webpush.generateVAPIDKeys();
// The api gets the public key only — exactly as in production.
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false', VAPID_PUBLIC_KEY: vapid.publicKey });
let db: Db;
let server: Server;
let base: string;

async function signedIn(subject: string): Promise<string> {
  await userForSubject(db, logger, subject, null);
  return `dm_session=${await mintSession(db, logger, subject)}`;
}
const post = (b: string, path: string, cookie: string, body: unknown) =>
  fetch(`${b}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

// What a browser's PushSubscription.toJSON() looks like.
function subscription(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('hex')}`) {
  return {
    endpoint,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
const rows = async () => (await db.query('select user_id, endpoint, p256dh, auth from push_subscriptions order by created_at')).rows;

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
  await db.query('truncate users cascade');
});

describe('GET /api/push/key', () => {
  it('gives the public key to a signed-in user', async () => {
    const cookie = await signedIn('sub_a');
    const res = await fetch(`${base}/api/push/key`, { headers: { cookie } });
    expect(await res.json()).toEqual({ publicKey: vapid.publicKey });
    expect((await fetch(`${base}/api/push/key`)).status).toBe(401);
  });

  it('is 503 when the server has no push keys', async () => {
    const bare = createServer(createApp({ config: loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' }), logger, db, oidc: null }));
    await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
    const cookie = await signedIn('sub_a');
    const res = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/push/key`, { headers: { cookie } });
    expect(res.status).toBe(503);
    await new Promise<void>((r) => bare.close(() => r()));
  });
});

describe('POST /api/push/subscribe', () => {
  it('stores the subscription for the signed-in user, and never echoes the endpoint', async () => {
    const cookie = await signedIn('sub_a');
    const s = subscription();
    const res = await post(base, '/api/push/subscribe', cookie, s);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(s.endpoint);
    expect(await rows()).toEqual([{ user_id: 'sub_a', endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }]);
  });

  it('keeps one row per browser — subscribing again updates it', async () => {
    const cookie = await signedIn('sub_a');
    const s = subscription();
    await post(base, '/api/push/subscribe', cookie, s);
    const again = { ...subscription(s.endpoint) };
    await post(base, '/api/push/subscribe', cookie, again);
    expect(await rows()).toEqual([{ user_id: 'sub_a', endpoint: s.endpoint, p256dh: again.keys.p256dh, auth: again.keys.auth }]);
  });

  it('moves a browser to whoever is signed in on it now', async () => {
    const a = await signedIn('sub_a');
    const b = await signedIn('sub_b');
    const s = subscription();
    await post(base, '/api/push/subscribe', a, s);
    await post(base, '/api/push/subscribe', b, s);
    expect((await rows()).map((r) => r.user_id)).toEqual(['sub_b']);
  });

  it('refuses anything that is not a browser push subscription', async () => {
    const cookie = await signedIn('sub_a');
    const good = subscription();
    for (const bad of [
      { ...good, endpoint: 'http://fcm.googleapis.com/x' }, // not https
      { ...good, endpoint: `https://x.example/${'a'.repeat(3000)}` }, // too long
      { ...good, keys: { ...good.keys, p256dh: 'short' } },
      { ...good, keys: { ...good.keys, auth: randomBytes(4).toString('base64url') } },
      { endpoint: good.endpoint },
    ]) {
      expect((await post(base, '/api/push/subscribe', cookie, bad)).status).toBe(400);
    }
    expect(await rows()).toEqual([]);
  });

  it('is 401 signed out', async () => {
    expect((await post(base, '/api/push/subscribe', '', subscription())).status).toBe(401);
  });
});

describe('POST /api/push/unsubscribe', () => {
  it("removes the caller's subscription for that browser only", async () => {
    const a = await signedIn('sub_a');
    const b = await signedIn('sub_b');
    const mine = subscription();
    const theirs = subscription();
    await post(base, '/api/push/subscribe', a, mine);
    await post(base, '/api/push/subscribe', b, theirs);
    await post(base, '/api/push/unsubscribe', a, { endpoint: theirs.endpoint }); // not a's: untouched
    await post(base, '/api/push/unsubscribe', a, { endpoint: mine.endpoint });
    expect((await rows()).map((r) => r.user_id)).toEqual(['sub_b']);
  });
});
