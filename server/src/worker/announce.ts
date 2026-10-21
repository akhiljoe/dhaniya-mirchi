// Announcements (design §13.3): the operator tells every user something. Never
// automatic — only `worker announce` creates one:
//
//   docker compose run --rm worker node dist/worker/main.js announce \
//     --title "Guests" --body "Tell us who's staying and the list gets ready." [--push] [--dry-run]
//
// The command stores it (every user then sees it under the bell). With --push,
// the running worker's sweep sends it once to each user's browsers, holding it
// through their household's quiet hours (§13.2). --dry-run stores and sends
// nothing and says who would get it.
import webpush from 'web-push';

import { ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX, DEFAULT_TIMEZONE } from '../constants.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { quietHours, type PushSender } from './notify.js';

export interface AnnounceArgs {
  title: string;
  body: string;
  push: boolean;
  dryRun: boolean;
}

// Reads `--title "…" --body "…" [--push] [--dry-run]`. Throws a usage line
// on anything else.
export function parseAnnounceArgs(argv: string[]): AnnounceArgs {
  const usage = 'usage: announce --title "…" --body "…" [--push] [--dry-run]';
  const out: Partial<AnnounceArgs> = { push: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') out.push = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if ((a === '--title' || a === '--body') && i + 1 < argv.length) out[a === '--title' ? 'title' : 'body'] = argv[++i].trim();
    else throw new Error(usage);
  }
  if (!out.title || !out.body) throw new Error(usage);
  if (out.title.length > ANNOUNCEMENT_TITLE_MAX) throw new Error(`the title is over ${ANNOUNCEMENT_TITLE_MAX} characters`);
  if (out.body.length > ANNOUNCEMENT_BODY_MAX) throw new Error(`the body is over ${ANNOUNCEMENT_BODY_MAX} characters`);
  return out as AnnounceArgs;
}

// Stores the announcement (unless a dry run). Returns who it reaches: every
// active user, and how many of them have a browser subscribed to pushes.
export async function announce(db: Db, a: AnnounceArgs): Promise<{ id: string | null; users: number; pushUsers: number }> {
  const { rows: counts } = await db.query<{ users: string; push_users: string }>(
    `select (select count(*) from users where status = 'active') as users,
            (select count(distinct s.user_id) from push_subscriptions s join users u on u.id = s.user_id where u.status = 'active') as push_users`,
  );
  const users = Number(counts[0].users);
  const pushUsers = a.push ? Number(counts[0].push_users) : 0;
  if (a.dryRun) return { id: null, users, pushUsers };
  const { rows } = await db.query<{ id: string }>('insert into announcements (title, body, push) values ($1, $2, $3) returning id', [a.title, a.body, a.push]);
  return { id: rows[0].id, users, pushUsers };
}

export interface DeliverDeps {
  db: Db;
  logger: Logger;
  sender: PushSender;
  now?: Date; // tests pin the clock
}

// One sweep: push each pushed announcement to each user who hasn't had it,
// once. The delivery is claimed before sending (a missed push beats a
// repeated one); a user in their quiet hours waits for the next sweep.
// Endpoints are capabilities: never logged.
export async function deliverAnnouncements(deps: DeliverDeps): Promise<number> {
  const { db, logger, sender } = deps;
  const now = deps.now ?? new Date();
  const { rows: due } = await db.query<{ announcement_id: string; title: string; body: string; user_id: string; timezone: string | null }>(
    `select a.id as announcement_id, a.title, a.body, u.id as user_id, h.timezone
       from announcements a
       cross join users u
       left join household_members m on m.user_id = u.id
       left join households h on h.id = m.household_id
      -- Someone who signed up long after an announcement sees it under the
      -- bell but isn't pushed old news.
      where a.push and u.status = 'active' and u.created_at <= a.created_at + interval '1 day'
        and exists (select 1 from push_subscriptions s where s.user_id = u.id)
        and not exists (select 1 from announcement_deliveries d where d.announcement_id = a.id and d.user_id = u.id)
      order by a.created_at`,
  );
  let sent = 0;
  for (const d of due) {
    if (quietHours(now, d.timezone ?? DEFAULT_TIMEZONE)) continue;
    const claimed = await db.query(
      'insert into announcement_deliveries (announcement_id, user_id) values ($1, $2) on conflict do nothing',
      [d.announcement_id, d.user_id],
    );
    if (!claimed.rowCount) continue;
    const payload = JSON.stringify({ title: d.title, body: d.body, url: '/?announcements=1', tag: `announcement-${d.announcement_id}` });
    const { rows: subs } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
      [d.user_id],
    );
    for (const s of subs) {
      try {
        const { gone } = await sender.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        if (gone) await db.query('delete from push_subscriptions where id = $1', [s.id]);
        else sent++;
      } catch (err) {
        const status = err instanceof webpush.WebPushError ? err.statusCode : null;
        logger.warn('announce: push failed', { announcement: d.announcement_id, status });
      }
    }
  }
  if (sent) logger.info('announce: pushed', { browsers: sent });
  return sent;
}
