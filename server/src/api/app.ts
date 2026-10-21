// The API request handler: routes /auth/* and /api/*. nginx (the `web`
// service) proxies both prefixes here; everything else is the SPA.
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleAuth, type AuthDeps } from '../auth/routes.js';
import { HttpError, sendJson } from '../http.js';
import { handleAi } from './ai.js';
import { handleAnnouncements } from './announcements.js';
import { handleConnect } from './connect.js';
import { handleCart } from './cart.js';
import { handleOrder } from './order.js';
import { handleProductPrefs } from './prefs.js';
import { handleFacts } from './facts.js';
import { handleCorrections } from './corrections.js';
import { handleRetired } from './retired.js';
import { handleFeedback } from './feedback.js';
import { handleHouseholds } from './households.js';
import { handleImports } from './imports.js';
import { handleMembers } from './members.js';
import { handleOrders } from './orders.js';
import { handlePush } from './push.js';
import { errorFields } from '../logger.js';
import { workerStatus, type WorkerStatus } from '../worker/status.js';

export function createApp(deps: AuthDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://internal');
    try {
      if (url.pathname.startsWith('/auth/')) return await handleAuth(deps, req, res, url);

      // Health is the api's own: it fails only when the database does. The
      // worker is reported, not required — the app keeps serving while the
      // worker is down (design §11 rule 4).
      if (url.pathname === '/api/health') {
        let dbOk = false;
        let worker: WorkerStatus | null = null;
        try {
          await deps.db.query('select 1');
          dbOk = true;
          worker = await workerStatus(deps.db, new Date());
        } catch (err) {
          deps.logger.warn('health: database unreachable', errorFields(err));
        }
        return sendJson(res, dbOk ? 200 : 503, { ok: dbOk, db: dbOk, worker });
      }

      if (await handleHouseholds(deps, req, res, url)) return;
      if (await handleMembers(deps, req, res, url)) return;
      if (await handleFacts(deps, req, res, url)) return;
      if (await handleRetired(deps, req, res, url)) return;
      if (await handleCorrections(deps, req, res, url)) return;
      if (await handleProductPrefs(deps, req, res, url)) return;
      if (await handleCart(deps, req, res, url)) return;
      if (await handleOrder(deps, req, res, url)) return;
      if (await handleAnnouncements(deps, req, res, url)) return;
      if (await handleFeedback(deps, req, res, url)) return;
      if (await handleAi(deps, req, res, url)) return;
      if (await handleConnect(deps, req, res, url)) return;
      if (await handleImports(deps, req, res, url)) return;
      if (await handleOrders(deps, req, res, url)) return;
      if (await handlePush(deps, req, res, url)) return;

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        return;
      }
      deps.logger.error('unhandled request error', { path: url.pathname, ...errorFields(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  };
}
