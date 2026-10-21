// "We don't buy this any more" (retired.ts): the items a household has
// retired, kept per household, and the way back.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { validateRetirement } from '../../src/api/retired.js';
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
  fetch(`${base}/api/household/retired`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const list = async (cookie: string) => (await (await fetch(`${base}/api/household/retired`, { headers: { cookie } })).json()).items as { item: string }[];

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

describe('what the household no longer buys', () => {
  it('starts empty, remembers what was retired, and takes it back', async () => {
    const cookie = await member('sub_a', 'a@x.com');
    expect(await list(cookie)).toEqual([]);
    const res = await put(cookie, { item: 'Pet pads', retired: true });
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: { item: string }) => i.item)).toEqual(['pet pads']);
    // Saying it twice is saying it once.
    await put(cookie, { item: 'pet pads', retired: true });
    expect((await list(cookie)).map((i) => i.item)).toEqual(['pet pads']);
    await put(cookie, { item: 'pet pads', retired: false });
    expect(await list(cookie)).toEqual([]);
  });

  it('keeps each household to its own', async () => {
    const a = await member('sub_b', 'b@x.com');
    const b = await member('sub_c', 'c@x.com');
    await put(a, { item: 'rusk', retired: true });
    expect((await list(a)).map((i) => i.item)).toEqual(['rusk']);
    expect(await list(b)).toEqual([]);
  });

  it('is 401 signed out and 403 without a household', async () => {
    expect((await fetch(`${base}/api/household/retired`)).status).toBe(401);
    const loner = await signIn('sub_d', 'd@x.com');
    expect((await fetch(`${base}/api/household/retired`, { headers: { cookie: loner } })).status).toBe(403);
  });

  it('refuses what makes no sense, with a sentence to show', async () => {
    const cookie = await member('sub_e', 'e@x.com');
    for (const bad of [{}, { item: '', retired: true }, { item: 'x'.repeat(61), retired: true }, { item: 'a\u0007b', retired: true }, { item: 'milk' }, { item: 'milk', retired: 'yes' }]) {
      expect((await put(cookie, bad)).status).toBe(400);
    }
    expect(validateRetirement({ item: '  Pet   Pads ', retired: true })).toEqual({ item: 'pet pads', retired: true });
  });
});
