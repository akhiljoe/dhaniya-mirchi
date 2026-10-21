// Import progress (design §7.10). The page polls this, so the user can close
// it and come back: progress lives in import_jobs, never in the tab.
//
//   GET  /api/imports                 → { imports: [...] }  the latest run per connection
//   POST /api/imports/:vendor/retry   → { queued: true }    run a stopped import again
//
// Household-scoped via requireHousehold. Counts, times and a code the page can
// explain only — never session material.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { DELIVERED_STATUS, IMPORT_CALL_DELAY_MS, VENDOR_PACK_LOOKUP_CALLS } from '../constants.js';
import { HttpError, sendJson } from '../http.js';
import { estimateImport } from '../worker/import/eta.js';
import { queueImport } from '../worker/import/import.js';
import { requireHousehold } from './households.js';

const LIVE = ['queued', 'listing', 'packs'];

interface JobRow {
  id: string;
  first: boolean;
  connection_id: string;
  vendor: string;
  status: string;
  orders_done: number;
  skus_total: number | null;
  skus_done: number;
  step_ms: number[];
  ready_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
  created_at: Date;
}

export async function handleImports(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const retry = url.pathname.match(/^\/api\/imports\/([a-z]+)\/retry$/);
  if (retry && req.method === 'POST') {
    await retryImport(deps, req, res, retry[1]);
    return true;
  }
  if (url.pathname !== '/api/imports' || req.method !== 'GET') return false;
  const { household } = await requireHousehold(deps, req);
  const { rows } = await deps.db.query<JobRow>(
    // `first`: no earlier run of this connection finished with orders — this
    // one reads the history; any later one is a sync for new orders.
    `select distinct on (j.connection_id)
            j.id, j.connection_id, j.vendor, j.status, j.orders_done, j.skus_total, j.skus_done, j.step_ms,
            j.ready_at, j.completed_at, j.error_code, j.created_at,
            not exists (select 1 from import_jobs e
                         where e.connection_id = j.connection_id and e.created_at < j.created_at
                           and e.status = 'complete' and e.orders_done > 0) as first
       from import_jobs j
      where j.household_id = $1
      order by j.connection_id, j.created_at desc`,
    [household.id],
  );
  // For an estimate while an order list is still being read: the lookups the
  // orders read so far need (the same count the pack phase starts from) …
  const reading = rows.filter((r) => LIVE.includes(r.status) && r.skus_total === null && r.orders_done > 0);
  const soFar = new Map<string, number>();
  for (const r of reading) {
    const { rows: n } = await deps.db.query<{ n: string }>(
      `select count(distinct ((i->>'storeId'), i->>'sku')) as n
         from raw_orders o, jsonb_array_elements(o.items) i
        where o.connection_id = $1 and o.status = $2
          and not exists (select 1 from sku_packs p
                           where p.vendor = o.vendor and p.store_id = (i->>'storeId')::bigint and p.sku = i->>'sku')`,
      [r.connection_id, DELIVERED_STATUS],
    );
    soFar.set(r.id, Number(n[0].n));
  }
  // … and how long a lookup took in the last import that timed any. Pack
  // sizes are product data shared by every household, and so is the pace.
  const { rows: measured } = await deps.db.query<{ ms: number | null }>(
    `select (select avg(x) from unnest(step_ms) x)::float as ms
       from import_jobs where cardinality(step_ms) > 0 order by updated_at desc limit 1`,
  );
  const now = new Date();
  sendJson(res, 200, {
    imports: rows
      .sort((a, b) => a.vendor.localeCompare(b.vendor))
      .map((r) => {
        const estimate = LIVE.includes(r.status)
          ? estimateImport(
              {
                skusTotal: r.skus_total,
                skusDone: r.skus_done,
                stepMs: r.step_ms,
                skusSoFar: soFar.get(r.id) ?? null,
                measuredLookupMs: measured[0]?.ms ?? null,
                // No call behind this vendor's pack lookups means no pause to
                // count (design §7.10).
                pauseMs: VENDOR_PACK_LOOKUP_CALLS[r.vendor] === false ? 0 : IMPORT_CALL_DELAY_MS,
              },
              now,
            )
          : null;
        return {
          connectionId: r.connection_id,
          // 'first' reads the order history; 'sync' fetches new orders only.
          kind: r.first ? 'first' : 'sync',
          vendor: r.vendor,
          status: r.status,
          ordersDone: r.orders_done,
          skusTotal: r.skus_total,
          skusDone: r.skus_done,
          readyAt: r.ready_at?.toISOString() ?? null,
          completedAt: r.completed_at?.toISOString() ?? null,
          errorCode: r.error_code,
          startedAt: r.created_at.toISOString(),
          estimate: estimate && {
            readyAt: estimate.readyAt?.toISOString() ?? null,
            completeAt: estimate.completeAt?.toISOString() ?? null,
            stillCounting: estimate.stillCounting,
          },
        };
      }),
  });
  return true;
}

// Every step of an import is idempotent, so a stopped one simply runs again
// and continues where it stopped. A live run is left alone (queueImport
// returns it). A connection the vendor no longer accepts needs the user's
// OTP first — retrying it would only fail again.
async function retryImport(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, vendor: string): Promise<void> {
  const { household } = await requireHousehold(deps, req);
  const { rows } = await deps.db.query<{ id: string; status: string }>(
    'select id, status from vendor_connections where household_id = $1 and vendor = $2',
    [household.id, vendor],
  );
  if (!rows.length) throw new HttpError(404, `no ${vendor} connection`);
  const active = rows.filter((r) => r.status === 'active');
  if (!active.length) throw new HttpError(409, `reconnect ${vendor} first`);
  for (const c of active) await queueImport(deps.db, c.id);
  sendJson(res, 200, { queued: true });
}
