// Household facts (design §9.12): who lives here, guests, pets, regular use,
// away. Household-scoped, checked, append-only.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { localToday, validateFact } from '../../src/api/facts.js';
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

async function member(subject: string, email: string): Promise<{ cookie: string; householdId: string }> {
  await userForSubject(db, logger, subject, email);
  const cookie = `dm_session=${await mintSession(db, logger, subject)}`;
  const res = await post('/api/households', cookie, { name: 'Home', timezone: 'Asia/Kolkata' });
  return { cookie, householdId: (await res.json()).household.id };
}
function post(path: string, cookie: string, body: unknown = {}) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const facts = async (cookie: string) => (await (await fetch(`${base}/api/household/facts`, { headers: { cookie } })).json()).facts;

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

describe('household facts', () => {
  it('stores each kind with the words said, and lists the ones in force', async () => {
    const a = await member('sub_a', 'me@gmail.com');
    const add = (body: unknown) => post('/api/household/facts', a.cookie, body);
    expect((await add({ kind: 'people', startsOn: '2026-06-01', details: { count: 4 }, said: 'Mother-in-law and brother-in-law live with us' })).status).toBe(201);
    expect((await add({ kind: 'pets', startsOn: '2024-01-01', details: { dogs: 2 } })).status).toBe(201);
    expect((await add({ kind: 'guests', startsOn: '2026-09-22', endsOn: '2026-09-29', details: { count: 3 } })).status).toBe(201);
    expect((await add({ kind: 'regular_use', startsOn: '2024-01-01', details: { item: 'Eggs', for: 'pets', perDay: 2, unit: 'piece' }, said: 'The dogs eat 2 boiled eggs a day' })).status).toBe(201);
    expect((await add({ kind: 'regular_use', startsOn: '2024-01-01', details: { item: 'carrot', for: 'pets' } })).status).toBe(201);
    expect((await add({ kind: 'away', startsOn: '2026-10-05', endsOn: '2026-10-12', details: {} })).status).toBe(201);

    const list = await facts(a.cookie);
    expect(list.map((f: { kind: string }) => f.kind)).toEqual(['pets', 'regular_use', 'regular_use', 'people', 'guests', 'away']);
    expect(list.find((f: { said: string | null }) => f.said?.startsWith('The dogs'))).toMatchObject({
      kind: 'regular_use',
      details: { item: 'eggs', for: 'pets', perDay: 2, unit: 'piece' },
      source: 'form',
      addedBy: 'me@gmail.com',
    });
    expect(list.find((f: { kind: string }) => f.kind === 'pets').details).toEqual({ dogs: 2, cats: 0, other: 0 });
  });

  it('withdraws a fact without deleting it', async () => {
    const a = await member('sub_a', 'me@gmail.com');
    const { fact } = await (await post('/api/household/facts', a.cookie, { kind: 'people', startsOn: '2026-06-01', details: { count: 4 } })).json();
    expect((await post(`/api/household/facts/${fact.id}/withdraw`, a.cookie)).status).toBe(200);
    expect(await facts(a.cookie)).toEqual([]);
    const { rows } = await db.query('select withdrawn_at, withdrawn_by from household_facts where id = $1', [fact.id]);
    expect(rows[0].withdrawn_by).toBe('sub_a');
    expect((await post(`/api/household/facts/${fact.id}/withdraw`, a.cookie)).status).toBe(404);
  });

  it("keeps one household's facts from another", async () => {
    const a = await member('sub_a', 'me@gmail.com');
    const b = await member('sub_b', 'b@gmail.com');
    const { fact } = await (await post('/api/household/facts', a.cookie, { kind: 'people', startsOn: '2026-06-01', details: { count: 4 } })).json();
    expect(await facts(b.cookie)).toEqual([]);
    expect((await post(`/api/household/facts/${fact.id}/withdraw`, b.cookie)).status).toBe(404);
    expect(await facts(a.cookie)).toHaveLength(1);
  });

  it('is 401 signed out and 403 without a household', async () => {
    expect((await fetch(`${base}/api/household/facts`)).status).toBe(401);
    await userForSubject(db, logger, 'sub_c', null);
    const cookie = `dm_session=${await mintSession(db, logger, 'sub_c')}`;
    expect((await fetch(`${base}/api/household/facts`, { headers: { cookie } })).status).toBe(403);
  });
});

describe('validateFact', () => {
  const today = '2026-09-19';
  const bad = (body: unknown) => () => validateFact(body, today);

  it('refuses what makes no sense, with a sentence to show', () => {
    expect(bad({ kind: 'people', startsOn: '2026-06-01', details: { count: 0 } })).toThrow(/how many people/);
    expect(bad({ kind: 'people', startsOn: '2026-06-01', endsOn: '2026-07-01', details: { count: 4 } })).toThrow(/guests/);
    expect(bad({ kind: 'guests', startsOn: '2026-09-22', details: { count: 3 } })).toThrow(/until when/);
    expect(bad({ kind: 'guests', startsOn: '2026-09-22', endsOn: '2026-09-20', details: { count: 3 } })).toThrow(/before the start/);
    expect(bad({ kind: 'regular_use', startsOn: '2026-01-01', details: { item: 'milk', for: 'people', perDay: 500 } })).toThrow(/ml, g or pieces/);
    expect(bad({ kind: 'regular_use', startsOn: '2026-01-01', details: { item: 'milk', for: 'cows' } })).toThrow(/people or pets/);
    expect(bad({ kind: 'party', startsOn: '2026-01-01', details: {} })).toThrow(/Unknown kind/);
    expect(bad({ kind: 'away', startsOn: '2026-02-30', details: {} })).toThrow(/YYYY-MM-DD/);
    expect(bad({ kind: 'away', startsOn: '2031-01-01', details: {} })).toThrow(/too far/);
  });

  it("reads the household's own date, not the server's", () => {
    // 20:00 UTC on Sep 18 is already Sep 19 in Kolkata.
    expect(localToday('Asia/Kolkata', new Date('2026-09-18T20:00:00Z'))).toBe('2026-09-19');
  });
});
