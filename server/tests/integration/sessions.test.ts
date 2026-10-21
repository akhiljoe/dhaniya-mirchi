// Users and sessions against real Postgres (design §14.3). The properties that
// matter are security properties, so each one is asserted directly.
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveSession, mintSession, revokeSession, userForSubject } from '../../src/auth/sessions.js';
import type { Db } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
let db: Db;

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users cascade');
});

describe('migrations', () => {
  it('apply once; a second run applies nothing', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query('select name from schema_migrations');
    expect(rows.map((r) => r.name)).toContain('001_users_sessions.sql');
  });
});

describe('userForSubject', () => {
  it('creates a user on first sign-in and returns the same one after', async () => {
    const first = await userForSubject(db, logger, 'sub_1', 'a@example.com');
    expect(first).toEqual({ ok: true, userId: 'sub_1', created: true });
    const again = await userForSubject(db, logger, 'sub_1', 'a@example.com');
    expect(again).toEqual({ ok: true, userId: 'sub_1', created: false });
    const { rows } = await db.query('select count(*)::int as n from users');
    expect(rows[0].n).toBe(1);
  });

  it('keeps the latest verified email, and never overwrites it with null', async () => {
    await userForSubject(db, logger, 'sub_1', 'old@example.com');
    await userForSubject(db, logger, 'sub_1', 'new@example.com');
    await userForSubject(db, logger, 'sub_1', null);
    const { rows } = await db.query('select email from users where id = $1', ['sub_1']);
    expect(rows[0].email).toBe('new@example.com');
  });

  it('refuses a suspended user', async () => {
    await userForSubject(db, logger, 'sub_1', null);
    await db.query(`update users set status = 'suspended' where id = 'sub_1'`);
    expect(await userForSubject(db, logger, 'sub_1', null)).toEqual({ ok: false, reason: 'suspended' });
  });
});

describe('sessions', () => {
  it('stores only the hash of the token — the token itself is never in the database', async () => {
    await userForSubject(db, logger, 'sub_1', null);
    const token = await mintSession(db, logger, 'sub_1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 random bits, base64url
    const { rows } = await db.query('select token_hash from sessions');
    expect(rows).toHaveLength(1);
    expect(Buffer.compare(rows[0].token_hash, createHash('sha256').update(token!).digest())).toBe(0);
    const dump = JSON.stringify((await db.query('select * from sessions')).rows);
    expect(dump).not.toContain(token);
  });

  it('resolves a live session to its user', async () => {
    await userForSubject(db, logger, 'sub_1', null);
    const token = await mintSession(db, logger, 'sub_1');
    expect(await resolveSession(db, logger, token!)).toMatchObject({ ok: true, userId: 'sub_1' });
  });

  it('gives the same answer for unknown, revoked and expired tokens', async () => {
    await userForSubject(db, logger, 'sub_1', null);
    const revoked = await mintSession(db, logger, 'sub_1');
    await revokeSession(db, logger, revoked!);
    const expired = await mintSession(db, logger, 'sub_1');
    await db.query(`update sessions set expires_at = now() - interval '1 second'
                     where token_hash = $1`, [createHash('sha256').update(expired!).digest()]);

    const unknown = 'A'.repeat(43);
    for (const t of [unknown, revoked!, expired!]) {
      expect(await resolveSession(db, logger, t)).toEqual({ ok: false, reason: 'unknown' });
    }
  });

  it('refuses an empty or overlong token before touching the database', async () => {
    expect(await resolveSession(db, logger, '')).toEqual({ ok: false, reason: 'absent' });
    expect(await resolveSession(db, logger, 'x'.repeat(10_000))).toEqual({ ok: false, reason: 'absent' });
  });

  it('refuses a session whose user has been suspended', async () => {
    await userForSubject(db, logger, 'sub_1', null);
    const token = await mintSession(db, logger, 'sub_1');
    await db.query(`update users set status = 'suspended' where id = 'sub_1'`);
    expect(await resolveSession(db, logger, token!)).toEqual({ ok: false, reason: 'suspended' });
  });

  it('revoking is idempotent and ends only that session', async () => {
    await userForSubject(db, logger, 'sub_1', null);
    const a = await mintSession(db, logger, 'sub_1');
    const b = await mintSession(db, logger, 'sub_1');
    await revokeSession(db, logger, a!);
    await revokeSession(db, logger, a!); // again: no error
    expect((await resolveSession(db, logger, a!)).ok).toBe(false);
    expect(await resolveSession(db, logger, b!)).toMatchObject({ ok: true, userId: 'sub_1' });
  });
});

describe('profile picture URL', () => {
  it('stores a Google photo URL, and keeps it when a later sign-in carries none', async () => {
    await userForSubject(db, logger, 'sub_1', null, 'https://lh3.googleusercontent.com/a/abc=s96-c');
    await userForSubject(db, logger, 'sub_1', null, null);
    const { rows } = await db.query('select picture_url from users where id = $1', ['sub_1']);
    expect(rows[0].picture_url).toBe('https://lh3.googleusercontent.com/a/abc=s96-c');
  });

  it('never stores a URL on any other host', async () => {
    await userForSubject(db, logger, 'sub_1', null, 'https://evil.example/a.png');
    const { rows } = await db.query('select picture_url from users where id = $1', ['sub_1']);
    expect(rows[0].picture_url).toBeNull();
  });
});
