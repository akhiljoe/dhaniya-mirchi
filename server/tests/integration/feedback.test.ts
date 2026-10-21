// "Send feedback" from the footer (design §12.8): signed-in users only,
// stored for the operator, checked.
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

const send = (cookie: string, body: unknown) =>
  fetch(`${base}/api/feedback`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
  await db.query('truncate users, feedback cascade');
});

describe('POST /api/feedback', () => {
  it('stores what was written, with the page it came from', async () => {
    await userForSubject(db, logger, 'sub_a', 'a@x.com');
    const cookie = `dm_session=${await mintSession(db, logger, 'sub_a')}`;
    expect((await send(cookie, { message: '  The mango flag is spot on.  ', page: 'insights' })).status).toBe(201);
    const { rows } = await db.query('select user_id, message, page from feedback');
    expect(rows).toEqual([{ user_id: 'sub_a', message: 'The mango flag is spot on.', page: 'insights' }]);
  });

  it('refuses an empty or too-long message, and keeps an odd page name out', async () => {
    await userForSubject(db, logger, 'sub_a', 'a@x.com');
    const cookie = `dm_session=${await mintSession(db, logger, 'sub_a')}`;
    expect((await send(cookie, { message: '   ' })).status).toBe(400);
    expect((await send(cookie, { message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await send(cookie, { message: 'ok', page: '<script>' })).status).toBe(201);
    expect((await db.query('select page from feedback')).rows[0].page).toBeNull();
  });

  it('is 401 signed out', async () => {
    expect((await send('', { message: 'hi' })).status).toBe(401);
  });
});
