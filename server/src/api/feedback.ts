// "Send feedback" from the footer (design §12.8).
//
//   POST /api/feedback   { message, page? } → 201 { sent: true }
//
// Signed-in users only. Stored for the operator (`worker feedback` prints it);
// the message is never logged.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { FEEDBACK_MAX, FEEDBACK_PAGE_MAX, MAX_BODY_BYTES } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireUser } from './households.js';

export async function handleFeedback(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/feedback' || req.method !== 'POST') return false;
  const userId = await requireUser(deps, req);
  const body = (await readJson(req, MAX_BODY_BYTES)) as { message?: unknown; page?: unknown };
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, 'Write something first.');
  if (message.length > FEEDBACK_MAX) throw new HttpError(400, `Keep it under ${FEEDBACK_MAX} characters.`);
  const page = typeof body.page === 'string' && /^[a-z-]{1,40}$/.test(body.page) ? body.page.slice(0, FEEDBACK_PAGE_MAX) : null;
  await deps.db.query('insert into feedback (user_id, message, page) values ($1, $2, $3)', [userId, message, page]);
  deps.logger.info('feedback received', { page });
  sendJson(res, 201, { sent: true });
  return true;
}
