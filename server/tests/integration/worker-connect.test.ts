// The worker's side of connecting a grocery app (design §7.10), driven by a
// FAKE vendor adapter so every path — including the failures — runs without a
// real phone. The real adapters are thin; the state machine is here.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, openSealed, seal } from '../../src/vault.js';
import {
  ConnectError,
  claimNextRequest,
  expireStaleRequests,
  runConnect,
  type ConnectAdapters,
  type ConnectSession,
} from '../../src/worker/connect.js';
import { freshTestDb } from './testdb.js';

const keys = generateVaultKeys();
const vault = { publicKey: keys.publicKey, privateKeys: [keys.privateKey] };
let db: Db;
let householdId: string;

const logLines: string[] = [];
const logger = createLogger({ level: 'debug', write: (l) => logLines.push(l) });

// A scripted vendor: records what it was given, fails where told to.
function fakeAdapter(script: { rejectPhone?: boolean; badOtps?: number; duringSend?: () => Promise<void> } = {}) {
  const calls = { phone: null as string | null, otps: [] as string[], closed: 0, opened: 0 };
  let bad = script.badOtps ?? 0;
  const adapters: ConnectAdapters = {
    instamart: {
      async open(): Promise<ConnectSession> {
        calls.opened++;
        return {
          async requestOtp(phone) {
            calls.phone = phone;
            await script.duringSend?.();
            if (script.rejectPhone) throw new ConnectError('vendor_rejected');
          },
          async submitOtp(otp) {
            calls.otps.push(otp);
            if (bad > 0) {
              bad--;
              throw new ConnectError('otp_invalid');
            }
            return { cookies: [{ name: 'sid', value: 'SESSION-SECRET', domain: '.instamart.in', path: '/' }], localStorage: {} };
          },
          async close() {
            calls.closed++;
          },
        };
      },
    },
  };
  return { adapters, calls };
}

async function newRequest(opts: { expiresInSeconds?: number; userId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into connect_requests (id, household_id, user_id, vendor, phone_sealed, phone_last4, status, expires_at)
     values ($1, $2, $3, 'instamart', $4, '3210', 'requested', now() + make_interval(secs => $5))`,
    [id, householdId, opts.userId ?? 'sub_a', seal(keys.publicKey, '9876543210', `connect_requests:${id}:phone`), opts.expiresInSeconds ?? 600],
  );
  return id;
}

async function statusOf(id: string) {
  return (await db.query('select * from connect_requests where id = $1', [id])).rows[0];
}

async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

// What the api does when the user types the code.
async function typeOtp(id: string, otp: string) {
  await db.query(`update connect_requests set otp_sealed = $2, status = 'verifying' where id = $1`, [
    id,
    seal(keys.publicKey, otp, `connect_requests:${id}:otp`),
  ]);
}

const deps = (adapters: ConnectAdapters) => ({ db, logger, vault, adapters, pollMs: 10 });

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
  await db.query(`insert into users (id) values ('sub_a'), ('sub_b')`);
  householdId = (await db.query(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`)).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_a', 'owner')`, [householdId]);
  logLines.length = 0;
});

describe('runConnect', () => {
  it('sends the OTP, waits for it, verifies, and stores the session sealed', async () => {
    const { adapters, calls } = fakeAdapter();
    const id = await newRequest();
    const done = runConnect(deps(adapters), id);

    await until(async () => (await statusOf(id)).status === 'otp_sent');
    expect(calls.phone).toBe('9876543210'); // opened in the worker only
    await typeOtp(id, '4821');
    await done;

    const row = await statusOf(id);
    expect(row.status).toBe('connected');
    // The phone and OTP don't outlive the attempt.
    expect(row.phone_sealed).toBeNull();
    expect(row.otp_sealed).toBeNull();
    expect(calls.otps).toEqual(['4821']);
    expect(calls.closed).toBe(1);

    const conn = (await db.query('select * from vendor_connections')).rows[0];
    expect(conn).toMatchObject({ household_id: householdId, user_id: 'sub_a', vendor: 'instamart', phone_last4: '3210', status: 'active' });
    expect(conn.session_sealed).not.toContain('SESSION-SECRET');
    const session = JSON.parse(openSealed(vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`));
    expect(session.cookies[0].value).toBe('SESSION-SECRET');
  });

  it('queues the first import as soon as the connection is made', async () => {
    const { adapters } = fakeAdapter();
    const id = await newRequest();
    const done = runConnect(deps(adapters), id);
    await until(async () => (await statusOf(id)).status === 'otp_sent');
    await typeOtp(id, '4821');
    await done;
    const conn = (await db.query('select id from vendor_connections')).rows[0];
    const jobs = (await db.query('select status, connection_id from import_jobs')).rows;
    expect(jobs).toEqual([{ status: 'queued', connection_id: conn.id }]);
  });

  it('lets the user retry a wrong code', async () => {
    const { adapters, calls } = fakeAdapter({ badOtps: 1 });
    const id = await newRequest();
    const done = runConnect(deps(adapters), id);
    await until(async () => (await statusOf(id)).status === 'otp_sent');
    await typeOtp(id, '1111');
    await until(async () => {
      const r = await statusOf(id);
      return r.status === 'otp_sent' && r.error_code === 'otp_invalid';
    });
    expect((await statusOf(id)).otp_sealed).toBeNull(); // the wrong code isn't kept
    await typeOtp(id, '4821');
    await done;
    expect((await statusOf(id)).status).toBe('connected');
    expect(calls.otps).toEqual(['1111', '4821']);
  });

  it('gives up after too many wrong codes', async () => {
    const { adapters, calls } = fakeAdapter({ badOtps: 99 });
    const id = await newRequest();
    const done = runConnect(deps(adapters), id);
    for (let i = 0; i < 3; i++) {
      await until(async () => (await statusOf(id)).status === 'otp_sent');
      await typeOtp(id, '1111');
      await until(async () => (await statusOf(id)).status !== 'verifying');
    }
    await done;
    const row = await statusOf(id);
    expect(row).toMatchObject({ status: 'failed', error_code: 'otp_invalid', phone_sealed: null, otp_sealed: null });
    expect(calls.closed).toBe(1);
    expect((await db.query('select count(*)::int as n from vendor_connections')).rows[0].n).toBe(0);
  });

  it('fails cleanly when the vendor rejects the number', async () => {
    const { adapters, calls } = fakeAdapter({ rejectPhone: true });
    const id = await newRequest();
    await runConnect(deps(adapters), id);
    expect(await statusOf(id)).toMatchObject({ status: 'failed', error_code: 'vendor_rejected', phone_sealed: null });
    expect(calls.closed).toBe(1);
  });

  it('expires while waiting for a code that never comes', async () => {
    const { adapters, calls } = fakeAdapter();
    const id = await newRequest({ expiresInSeconds: 1 });
    await runConnect(deps(adapters), id);
    expect(await statusOf(id)).toMatchObject({ status: 'expired', error_code: 'expired', phone_sealed: null });
    expect(calls.closed).toBe(1);
  });

  it('reconnecting replaces the existing connection for that user and vendor', async () => {
    for (let i = 0; i < 2; i++) {
      const { adapters } = fakeAdapter();
      const id = await newRequest();
      const done = runConnect(deps(adapters), id);
      await until(async () => (await statusOf(id)).status === 'otp_sent');
      await typeOtp(id, '4821');
      await done;
    }
    const conns = (await db.query('select * from vendor_connections')).rows;
    expect(conns).toHaveLength(1);
    expect(conns[0].status).toBe('active');
  });

  it('never logs the phone number, the OTP or the session', async () => {
    const { adapters } = fakeAdapter({ badOtps: 1 });
    const id = await newRequest();
    const done = runConnect(deps(adapters), id);
    await until(async () => (await statusOf(id)).status === 'otp_sent');
    await typeOtp(id, '1111');
    await until(async () => (await statusOf(id)).error_code === 'otp_invalid');
    await typeOtp(id, '4821');
    await done;
    const all = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);
    for (const secret of ['9876543210', '1111', '4821', 'SESSION-SECRET']) expect(all).not.toContain(secret);
  });
});

// What the api does when the user taps "Wrong number?".
async function cancel(id: string) {
  await db.query(
    `update connect_requests set status = 'cancelled', phone_sealed = null, otp_sealed = null
      where id = $1 and status in ('requested', 'sending_otp', 'otp_sent')`,
    [id],
  );
}

describe('cancelling', () => {
  it('stops waiting for a code, closes the browser, and leaves the attempt cancelled', async () => {
    const { adapters, calls } = fakeAdapter();
    const id = await newRequest();
    const done = runConnect(deps(adapters), id);
    await until(async () => (await statusOf(id)).status === 'otp_sent');
    await cancel(id);
    await done;

    expect((await statusOf(id)).status).toBe('cancelled');
    expect(calls.otps).toEqual([]);
    expect(calls.closed).toBe(1);
    expect((await db.query('select 1 from vendor_connections')).rowCount).toBe(0);
  });

  it('is not overwritten when the vendor finishes sending after the cancel', async () => {
    const { adapters, calls } = fakeAdapter({ duringSend: () => cancelWhenSending() });
    let id = '';
    const cancelWhenSending = () => cancel(id);
    id = await newRequest();
    await runConnect(deps(adapters), id); // returns without waiting for a code

    expect((await statusOf(id)).status).toBe('cancelled');
    expect(calls.closed).toBe(1);
  });

  it('never starts an attempt cancelled before the worker took it', async () => {
    const { adapters, calls } = fakeAdapter();
    const id = await newRequest();
    await cancel(id);
    expect(await claimNextRequest(db)).toBeNull();
    await runConnect(deps(adapters), id);

    expect(calls.opened).toBe(0);
    expect(calls.phone).toBeNull();
    expect((await statusOf(id)).status).toBe('cancelled');
  });
});

describe('claiming work', () => {
  it('hands each request to exactly one claimant', async () => {
    const id = await newRequest();
    const [a, b] = await Promise.all([claimNextRequest(db), claimNextRequest(db)]);
    expect([a, b].filter(Boolean)).toEqual([id]);
    expect((await statusOf(id)).status).toBe('sending_otp');
  });

  it('never claims an expired request', async () => {
    const id = await newRequest();
    await db.query(`update connect_requests set expires_at = now() - interval '1 second' where id = $1`, [id]);
    expect(await claimNextRequest(db)).toBeNull();
  });

  it('expires stale in-flight requests left by a crashed worker, clearing their secrets', async () => {
    const id = await newRequest();
    await db.query(
      `update connect_requests set status = 'otp_sent', expires_at = now() - interval '1 second' where id = $1`,
      [id],
    );
    expect(await expireStaleRequests(db)).toBe(1);
    expect(await statusOf(id)).toMatchObject({ status: 'expired', error_code: 'expired', phone_sealed: null, otp_sealed: null });
  });
});

describe('the connect loop', () => {
  it('picks up a new attempt as soon as it is announced, and stops cleanly', async () => {
    const { startConnectLoop } = await import('../../src/worker/connect-loop.js');
    const { adapters } = fakeAdapter();
    const { testDatabaseUrl } = await import('./testdb.js');
    const loop = await startConnectLoop({ db, logger, vault, adapters, pollMs: 10 }, testDatabaseUrl(), { sweepMs: 60_000 });
    try {
      const id = await newRequest();
      await db.query(`select pg_notify('connect_requests', $1)`, [id]);
      // Sweep is 60 s here, so reaching otp_sent quickly proves the NOTIFY woke it.
      await until(async () => (await statusOf(id)).status === 'otp_sent', 3000);
      await typeOtp(id, '4821');
      await until(async () => (await statusOf(id)).status === 'connected', 3000);
    } finally {
      await loop.stop();
    }
  });

  it('finds attempts that arrived with no announcement on its next sweep', async () => {
    const { startConnectLoop } = await import('../../src/worker/connect-loop.js');
    const { adapters } = fakeAdapter();
    const { testDatabaseUrl } = await import('./testdb.js');
    const id = await newRequest(); // no NOTIFY
    const loop = await startConnectLoop({ db, logger, vault, adapters, pollMs: 10 }, testDatabaseUrl(), { sweepMs: 50 });
    try {
      await until(async () => (await statusOf(id)).status === 'otp_sent', 3000);
    } finally {
      await loop.stop();
    }
  });
});

describe('shutdown', () => {
  it('ends an attempt waiting for a code as interrupted, promptly', async () => {
    const { startConnectLoop } = await import('../../src/worker/connect-loop.js');
    const { adapters, calls } = fakeAdapter();
    const { testDatabaseUrl } = await import('./testdb.js');
    const id = await newRequest();
    const loop = await startConnectLoop({ db, logger, vault, adapters, pollMs: 10 }, testDatabaseUrl(), { sweepMs: 50 });
    await until(async () => (await statusOf(id)).status === 'otp_sent', 3000);
    const started = Date.now();
    await loop.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await statusOf(id)).toMatchObject({ status: 'failed', error_code: 'interrupted', phone_sealed: null });
    expect(calls.closed).toBe(1);
  });
});
