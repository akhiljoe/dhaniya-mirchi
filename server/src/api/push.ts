// Turning notifications on (design §13.1).
//
//   GET  /api/push/key          → { publicKey }   the VAPID public key to subscribe with
//   POST /api/push/subscribe    PushSubscription.toJSON() → { subscribed: true }
//   POST /api/push/unsubscribe  { endpoint }      → { unsubscribed: boolean }
//
// Per user, not per household: a subscription is one person's browser. The
// endpoint is a capability URL, so it is stored for the worker and never
// echoed to a page or logged.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { MAX_BODY_BYTES, PUSH_AUTH_BYTES, PUSH_ENDPOINT_MAX, PUSH_P256DH_BYTES } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireUser } from './households.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function key(value: unknown, bytes: number): string | null {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null;
  return Buffer.from(value, 'base64url').length === bytes ? value : null;
}

function endpointOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > PUSH_ENDPOINT_MAX) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export async function handlePush(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/push/key' && req.method === 'GET') {
    await requireUser(deps, req);
    const publicKey = deps.config.push.publicKey;
    if (!publicKey) throw new HttpError(503, 'notifications are not set up on this server');
    sendJson(res, 200, { publicKey });
    return true;
  }

  if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const userId = await requireUser(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = endpointOf(body.endpoint);
    const p256dh = key(body.keys?.p256dh, PUSH_P256DH_BYTES);
    const auth = key(body.keys?.auth, PUSH_AUTH_BYTES);
    if (!endpoint || !p256dh || !auth) throw new HttpError(400, 'not a push subscription');
    // One row per browser: subscribing again refreshes its keys, and a browser
    // someone else signs in on becomes theirs.
    await deps.db.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
       on conflict (endpoint) do update
         set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now()`,
      [userId, endpoint, p256dh, auth],
    );
    sendJson(res, 200, { subscribed: true });
    return true;
  }

  if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const userId = await requireUser(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { endpoint?: unknown };
    const endpoint = endpointOf(body.endpoint);
    if (!endpoint) throw new HttpError(400, 'not a push subscription');
    const { rowCount } = await deps.db.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [endpoint, userId]);
    sendJson(res, 200, { unsubscribed: Boolean(rowCount) });
    return true;
  }

  return false;
}
