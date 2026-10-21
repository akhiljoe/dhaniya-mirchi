// "Your history is in" (design §7.10, §13): the worker tells the household
// when its first import is ready to use and when it's complete — once each,
// never during quiet hours, only to the household's own browsers. A FAKE
// sender stands in for the push service.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { sendImportNotices, type PushSender, type PushSubscriptionKeys } from '../../src/worker/notify.js';
import { freshTestDb } from './testdb.js';

let db: Db;
let householdId: string;
let connectionId: string;
const logLines: string[] = [];
const logger = createLogger({ level: 'debug', write: (l) => logLines.push(l) });

// 12:00 and 23:30 in Asia/Kolkata (UTC+5:30).
const NOON_IST = new Date('2026-09-19T06:30:00Z');
const LATE_IST = new Date('2026-09-19T18:00:00Z');
const MORNING_IST = new Date('2026-09-20T03:00:00Z'); // 08:30

function fakeSender(gone: string[] = [], failing: string[] = []) {
  const sent: { endpoint: string; payload: { title: string; body: string; url: string } }[] = [];
  const sender: PushSender = {
    async send(sub: PushSubscriptionKeys, payload: string) {
      if (failing.includes(sub.endpoint)) throw new Error('push service unavailable');
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { gone: gone.includes(sub.endpoint) };
    },
  };
  return { sender, sent };
}

async function subscribe(userId: string, endpoint: string) {
  await db.query(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'pk', 'au')`, [userId, endpoint]);
}

async function job(fields: Record<string, unknown>, createdAgoSeconds = 0): Promise<string> {
  const cols = Object.keys(fields);
  const { rows } = await db.query<{ id: string }>(
    `insert into import_jobs (household_id, connection_id, vendor, created_at${cols.map((c) => `, ${c}`).join('')})
     values ($1, $2, 'instamart', now() - make_interval(secs => $3)${cols.map((_, i) => `, $${i + 4}`).join('')})
     returning id`,
    [householdId, connectionId, createdAgoSeconds, ...Object.values(fields)],
  );
  return rows[0].id;
}

const deps = (sender: PushSender, now: Date) => ({ db, logger, sender, now });

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
  await db.query(`insert into users (id) values ('sub_a'), ('sub_b'), ('sub_other')`);
  householdId = (await db.query(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`)).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_a', 'owner'), ($1, 'sub_b', 'member')`, [householdId]);
  const other = (await db.query(`insert into households (name, timezone) values ('Other', 'Asia/Kolkata') returning id`)).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_other', 'owner')`, [other]);
  connectionId = (
    await db.query(
      `insert into vendor_connections (household_id, user_id, vendor, phone_last4, session_sealed, status)
       values ($1, 'sub_a', 'instamart', '3210', 'v1.sealed', 'active') returning id`,
      [householdId],
    )
  ).rows[0].id;
  await subscribe('sub_a', 'https://push.example/a-laptop');
  await subscribe('sub_b', 'https://push.example/b-phone');
  await subscribe('sub_other', 'https://push.example/other');
  logLines.length = 0;
});

describe('sendImportNotices', () => {
  it("tells every member's browser when the first import is complete — once", async () => {
    await job({ status: 'complete', orders_done: 235, ready_at: new Date(), completed_at: new Date() });
    const { sender, sent } = fakeSender();
    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example/a-laptop', 'https://push.example/b-phone']);
    expect(sent[0].payload).toMatchObject({ title: 'Your Instamart history is in', url: '/' });
    expect(sent[0].payload.body).toContain('120 orders');

    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent).toHaveLength(2); // never twice
  });

  it('says "ready to use" early, then "complete" later', async () => {
    const id = await job({ status: 'packs', orders_done: 235, skus_total: 600, skus_done: 120, ready_at: new Date() });
    const { sender, sent } = fakeSender();
    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent.map((s) => s.payload.title)).toEqual(['Your household is ready', 'Your household is ready']);

    await db.query(`update import_jobs set status = 'complete', completed_at = now() where id = $1`, [id]);
    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent.slice(2).map((s) => s.payload.title)).toEqual(['Your Instamart history is in', 'Your Instamart history is in']);
  });

  it('holds a notice during quiet hours and sends it in the morning', async () => {
    await job({ status: 'complete', orders_done: 10, ready_at: new Date(), completed_at: new Date() });
    const { sender, sent } = fakeSender();
    await sendImportNotices(deps(sender, LATE_IST));
    expect(sent).toEqual([]);
    await sendImportNotices(deps(sender, MORNING_IST));
    expect(sent).toHaveLength(2);
  });

  it('stays quiet for later syncs — only the first import is news', async () => {
    await job({ status: 'complete', orders_done: 235, ready_at: new Date(), completed_at: new Date(), complete_notified_at: new Date(), ready_notified_at: new Date() }, 86_400);
    await job({ status: 'complete', orders_done: 3, ready_at: new Date(), completed_at: new Date() });
    const { sender, sent } = fakeSender();
    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent).toEqual([]);
  });

  it('forgets a browser the push service says is gone, and still reaches the rest', async () => {
    await job({ status: 'complete', orders_done: 5, ready_at: new Date(), completed_at: new Date() });
    const { sender, sent } = fakeSender(['https://push.example/a-laptop']);
    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent).toHaveLength(2);
    const left = (await db.query(`select endpoint from push_subscriptions order by endpoint`)).rows.map((r) => r.endpoint);
    expect(left).toEqual(['https://push.example/b-phone', 'https://push.example/other']);
  });

  it('survives a failing push service without logging the endpoint', async () => {
    await job({ status: 'complete', orders_done: 5, ready_at: new Date(), completed_at: new Date() });
    const { sender, sent } = fakeSender([], ['https://push.example/a-laptop']);
    await sendImportNotices(deps(sender, NOON_IST));
    expect(sent.map((s) => s.endpoint)).toEqual(['https://push.example/b-phone']);
    expect(logLines.join('\n')).not.toContain('push.example');
  });
});
