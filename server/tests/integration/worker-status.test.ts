// The worker records a heartbeat; the api reports whether it's alive (design
// §7.4: "each adapter reports health so a silent sync failure is caught").
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config.js';
import { WORKER_STALE_AFTER_MS } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { recordHeartbeat, workerStatus } from '../../src/worker/status.js';
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
  await db.query('truncate worker_status');
});

describe('worker status', () => {
  it('is not alive before any heartbeat', async () => {
    expect(await workerStatus(db, new Date())).toEqual({ alive: false, lastSeenAt: null, chromeVersion: null });
  });

  it('is alive right after a heartbeat and records the browser version', async () => {
    await recordHeartbeat(db, { chromeVersion: '139.0.7258.66' });
    const s = await workerStatus(db, new Date());
    expect(s.alive).toBe(true);
    expect(s.chromeVersion).toBe('139.0.7258.66');
  });

  it('is not alive once the heartbeat is older than the stale threshold', async () => {
    await recordHeartbeat(db, { chromeVersion: '139' });
    const later = new Date(Date.now() + WORKER_STALE_AFTER_MS + 1_000);
    expect((await workerStatus(db, later)).alive).toBe(false);
  });

  it('keeps one row no matter how many heartbeats', async () => {
    for (let i = 0; i < 5; i++) await recordHeartbeat(db, { chromeVersion: `v${i}` });
    const { rows } = await db.query('select count(*)::int as n from worker_status');
    expect(rows[0].n).toBe(1);
    expect((await workerStatus(db, new Date())).chromeVersion).toBe('v4');
  });
});

describe('health includes the worker', () => {
  it('reports the worker alongside the database — a dead worker does not fail health', async () => {
    const server = createServer(createApp({ config: loadConfig({ DATABASE_URL: 'postgres://unused' }), logger, db, oidc: null }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    let body = await (await fetch(`${base}/api/health`)).json();
    expect(body).toMatchObject({ ok: true, db: true, worker: { alive: false } });

    await recordHeartbeat(db, { chromeVersion: '139' });
    body = await (await fetch(`${base}/api/health`)).json();
    expect(body).toMatchObject({ ok: true, db: true, worker: { alive: true, chromeVersion: '139' } });
    await new Promise<void>((r) => server.close(() => r()));
  });
});
