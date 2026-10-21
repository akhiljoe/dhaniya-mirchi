// Product preferences (design §19 Ordering, "which product"): per item, the
// products a household wants in order and the ones never to add. Shared by
// the household, checked, and kept to it.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession, userForSubject } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import { PRODUCT_PREFS_MAX } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' });
let db: Db;
let server: Server;
let base: string;

async function signIn(subject: string, email: string): Promise<string> {
  await userForSubject(db, logger, subject, email);
  return `dm_session=${await mintSession(db, logger, subject)}`;
}
async function member(subject: string, email: string): Promise<string> {
  const cookie = await signIn(subject, email);
  await fetch(`${base}/api/households`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Home', timezone: 'Asia/Kolkata' }) });
  return cookie;
}
const put = (cookie: string, body: unknown) =>
  fetch(`${base}/api/household/product-prefs`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const prefs = async (cookie: string) => (await (await fetch(`${base}/api/household/product-prefs`, { headers: { cookie } })).json()).prefs;

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

describe('product preferences', () => {
  it('keeps the order a household sets for an item, and the products never to add', async () => {
    const a = await member('sub_a', 'a@x.com');
    const res = await put(a, { item: 'milk', ranked: ['Nandini Pasteurised Toned Milk', 'Amul Taaza Toned Milk', 'Akshayakalpa Pasteurized Cow Milk Pouch'], blocked: ['Arokya Toned Milk'] });
    expect(res.status).toBe(200);
    expect(await prefs(a)).toMatchObject([
      { item: 'milk', ranked: ['Nandini Pasteurised Toned Milk', 'Amul Taaza Toned Milk', 'Akshayakalpa Pasteurized Cow Milk Pouch'], blocked: ['Arokya Toned Milk'] },
    ]);
    // A change replaces the order.
    await put(a, { item: 'milk', ranked: ['Amul Taaza Toned Milk', 'Nandini Pasteurised Toned Milk'], blocked: [] });
    expect((await prefs(a))[0]).toMatchObject({ ranked: ['Amul Taaza Toned Milk', 'Nandini Pasteurised Toned Milk'], blocked: [] });
  });

  it('goes back to the household’s own buying order when cleared', async () => {
    const a = await member('sub_a', 'a@x.com');
    await put(a, { item: 'milk', ranked: ['Nandini Toned Milk'], blocked: [] });
    expect((await (await put(a, { item: 'milk', ranked: [], blocked: [] })).json()).pref).toBeNull();
    expect(await prefs(a)).toEqual([]);
  });

  it('drops repeats and tidies spaces', async () => {
    const a = await member('sub_a', 'a@x.com');
    await put(a, { item: 'milk', ranked: ['Nandini  Toned Milk', 'nandini toned milk', 'Amul Gold'], blocked: [] });
    expect((await prefs(a))[0].ranked).toEqual(['Nandini Toned Milk', 'Amul Gold']);
  });

  it('refuses what isn’t a list of names', async () => {
    const a = await member('sub_a', 'a@x.com');
    expect((await put(a, { item: '', ranked: ['x'] })).status).toBe(400);
    expect((await put(a, { item: 'milk', ranked: 'Nandini' })).status).toBe(400);
    expect((await put(a, { item: 'milk', ranked: [42] })).status).toBe(400);
    expect((await put(a, { item: 'milk', ranked: ['bad\nname'] })).status).toBe(400);
    expect((await put(a, { item: 'milk', ranked: Array.from({ length: PRODUCT_PREFS_MAX + 1 }, (_, i) => `p${i}`) })).status).toBe(400);
    expect((await put(a, { item: 'milk', ranked: ['Nandini'], blocked: ['NANDINI'] })).status).toBe(400);
  });

  it('keeps each household to its own, and needs a household', async () => {
    const a = await member('sub_a', 'a@x.com');
    const b = await member('sub_b', 'b@x.com');
    await put(a, { item: 'milk', ranked: ['Nandini Toned Milk'], blocked: [] });
    expect(await prefs(b)).toEqual([]);
    const none = await signIn('sub_c', 'c@x.com');
    expect((await put(none, { item: 'milk', ranked: ['x'], blocked: [] })).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/household/product-prefs`)).status).toBe(401);
  });
});
