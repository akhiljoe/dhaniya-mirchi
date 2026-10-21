// Announcements (design §13.3): created only by the operator's command, seen
// by every user under the bell, and — when asked — pushed once per user,
// never in their quiet hours. A FAKE sender stands in for the push service.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { mintSession } from '../../src/auth/sessions.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { announce, deliverAnnouncements, parseAnnounceArgs } from '../../src/worker/announce.js';
import type { PushSender } from '../../src/worker/notify.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const config = loadConfig({ DATABASE_URL: 'postgres://unused', AUTH_SECURE_COOKIES: 'false' });
let db: Db;
let server: Server;
let base: string;

const NOON_IST = new Date('2026-09-19T06:30:00Z');
const LATE_IST = new Date('2026-09-19T18:00:00Z'); // 23:30

function fakeSender() {
  const sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string } }[] = [];
  const sender: PushSender = {
    async send(sub, payload) {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { gone: false };
    },
  };
  return { sender, sent };
}

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
  await db.query('truncate users, households, announcements cascade');
  await db.query(`insert into users (id, email, created_at) values ('sub_a', 'a@x.com', now() - interval '30 days'), ('sub_b', 'b@x.com', now() - interval '30 days')`);
  const { rows } = await db.query<{ id: string }>(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`);
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_a', 'owner')`, [rows[0].id]);
  await db.query(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ('sub_a', 'https://push.example/a', 'pk', 'au')`);
});

describe('the operator command', () => {
  it('reads its arguments, and refuses anything else', () => {
    expect(parseAnnounceArgs(['--title', ' New ', '--body', 'Guests are here.', '--push'])).toEqual({ title: 'New', body: 'Guests are here.', push: true, dryRun: false });
    expect(() => parseAnnounceArgs(['--title', 'Only a title'])).toThrow(/usage/);
    expect(() => parseAnnounceArgs(['--title', 'x', '--body', 'y', '--everyone'])).toThrow(/usage/);
    expect(() => parseAnnounceArgs(['--title', 'x'.repeat(81), '--body', 'y'])).toThrow(/over 80/);
  });

  it('a dry run stores nothing and says who it would reach', async () => {
    const r = await announce(db, { title: 'T', body: 'B', push: true, dryRun: true });
    expect(r).toEqual({ id: null, users: 2, pushUsers: 1 });
    expect((await db.query('select 1 from announcements')).rowCount).toBe(0);
  });
});

describe('push delivery', () => {
  it('pushes a pushed announcement once per user, and never one without --push', async () => {
    await announce(db, { title: 'Quiet one', body: 'Bell only.', push: false, dryRun: false });
    await announce(db, { title: 'Guests', body: 'Tell us who is staying.', push: true, dryRun: false });
    const { sender, sent } = fakeSender();
    await deliverAnnouncements({ db, logger, sender, now: NOON_IST });
    await deliverAnnouncements({ db, logger, sender, now: NOON_IST });
    expect(sent.map((s) => s.payload.title)).toEqual(['Guests']);
    expect(sent[0].payload.url).toBe('/?announcements=1');
  });

  it('waits out quiet hours in the household timezone', async () => {
    await announce(db, { title: 'Guests', body: 'Tell us who is staying.', push: true, dryRun: false });
    const { sender, sent } = fakeSender();
    await deliverAnnouncements({ db, logger, sender, now: LATE_IST });
    expect(sent).toHaveLength(0);
    await deliverAnnouncements({ db, logger, sender, now: NOON_IST });
    expect(sent).toHaveLength(1);
  });
});

describe('under the bell', () => {
  it('lists announcements newest first, unread until opened, per user', async () => {
    await announce(db, { title: 'First', body: 'One.', push: false, dryRun: false });
    await db.query(`update announcements set created_at = now() - interval '1 hour'`);
    await announce(db, { title: 'Second', body: 'Two.', push: false, dryRun: false });
    const a = `dm_session=${await mintSession(db, logger, 'sub_a')}`;
    const b = `dm_session=${await mintSession(db, logger, 'sub_b')}`;

    const list = async (cookie: string) => (await fetch(`${base}/api/announcements`, { headers: { cookie } })).json();
    const before = await list(a);
    expect(before.announcements.map((x: { title: string }) => x.title)).toEqual(['Second', 'First']);
    expect(before.unread).toBe(2);

    const res = await fetch(`${base}/api/announcements/read`, { method: 'POST', headers: { cookie: a, 'content-type': 'application/json' }, body: '{}' });
    expect(await res.json()).toEqual({ read: 2 });
    expect((await list(a)).unread).toBe(0);
    expect((await list(b)).unread).toBe(2);
  });

  it('is 401 signed out', async () => {
    expect((await fetch(`${base}/api/announcements`)).status).toBe(401);
  });
});
