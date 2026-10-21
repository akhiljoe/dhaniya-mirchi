// Announcements under the bell (design §13.3). Created only by the operator's
// `worker announce`; here a signed-in user reads them and marks them read.
//
//   GET  /api/announcements       → { announcements: [...], unread }  newest first
//   POST /api/announcements/read  → { read: n }  every one shown is now read
//
// Per user, not per household: each person reads their own.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { ANNOUNCEMENTS_SHOWN } from '../constants.js';
import { sendJson } from '../http.js';
import { requireUser } from './households.js';

export async function handleAnnouncements(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/announcements' && req.method === 'GET') {
    const userId = await requireUser(deps, req);
    const { rows } = await deps.db.query<{ id: string; title: string; body: string; created_at: Date; read: boolean }>(
      `select a.id, a.title, a.body, a.created_at,
              exists (select 1 from announcement_reads r where r.announcement_id = a.id and r.user_id = $1) as read
         from announcements a
        order by a.created_at desc
        limit $2`,
      [userId, ANNOUNCEMENTS_SHOWN],
    );
    sendJson(res, 200, {
      announcements: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at.toISOString(), read: r.read })),
      unread: rows.filter((r) => !r.read).length,
    });
    return true;
  }

  if (url.pathname === '/api/announcements/read' && req.method === 'POST') {
    const userId = await requireUser(deps, req);
    const { rowCount } = await deps.db.query(
      `insert into announcement_reads (announcement_id, user_id)
       select id, $1 from (select id from announcements order by created_at desc limit $2) shown
       on conflict do nothing`,
      [userId, ANNOUNCEMENTS_SHOWN],
    );
    sendJson(res, 200, { read: rowCount ?? 0 });
    return true;
  }

  return false;
}
