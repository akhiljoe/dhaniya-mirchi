// "I have more" / "Already finished" / "Not sure" (corrections.ts): kept per
// household, the latest word wins, and it can be taken back.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { validateCorrection } from '../../src/api/corrections.js';
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
  fetch(`${base}/api/household/corrections`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const list = async (cookie: string) =>
  (await (await fetch(`${base}/api/household/corrections`, { headers: { cookie } })).json()).corrections as { item: string; kind: string; saidAt: string }[];

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

describe('what the household said about an estimate', () => {
  it('keeps the latest word per item, with when it was said, and takes it back', async () => {
    const cookie = await member('sub_a', 'a@x.com');
    expect(await list(cookie)).toEqual([]);
    await put(cookie, { item: 'Milk', kind: 'more' });
    const first = await list(cookie);
    expect(first).toMatchObject([{ item: 'milk', kind: 'more' }]);
    await new Promise((r) => setTimeout(r, 20));
    await put(cookie, { item: 'milk', kind: 'finished' });
    const second = await list(cookie);
    expect(second).toMatchObject([{ item: 'milk', kind: 'finished' }]);
    // Said again is said now: the moment moves with the word.
    expect(Date.parse(second[0].saidAt)).toBeGreaterThan(Date.parse(first[0].saidAt));
    await put(cookie, { item: 'milk', kind: null });
    expect(await list(cookie)).toEqual([]);
  });

  it('keeps each household to its own', async () => {
    const a = await member('sub_b', 'b@x.com');
    const b = await member('sub_c', 'c@x.com');
    await put(a, { item: 'curd', kind: 'unsure' });
    expect(await list(a)).toMatchObject([{ item: 'curd' }]);
    expect(await list(b)).toEqual([]);
  });

  it('is 401 signed out and 403 without a household', async () => {
    expect((await fetch(`${base}/api/household/corrections`)).status).toBe(401);
    const loner = await signIn('sub_d', 'd@x.com');
    expect((await fetch(`${base}/api/household/corrections`, { headers: { cookie: loner } })).status).toBe(403);
  });

  it('refuses what makes no sense', async () => {
    const cookie = await member('sub_e', 'e@x.com');
    for (const bad of [{}, { item: '', kind: 'more' }, { item: 'milk', kind: 'plenty' }, { item: 'milk' }, { item: 'a\u0007b', kind: 'more' }]) {
      expect((await put(cookie, bad)).status).toBe(400);
    }
    expect(validateCorrection({ item: '  Pet   Pads ', kind: 'more' })).toEqual({ item: 'pet pads', kind: 'more' });
    expect(validateCorrection({ item: 'milk', kind: null })).toEqual({ item: 'milk', kind: null });
  });
});
