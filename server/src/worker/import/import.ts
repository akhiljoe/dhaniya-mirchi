// Importing a connection's order history (design §7.10).
//
//   queued ──claim──▶ listing ──all pages──▶ packs ──all SKUs──▶ complete
//                        │                     │   (ready_at once the most-bought are done)
//                        └── session refused ──┴──▶ needs_reconnect      other errors ──▶ failed
//
// Listing walks the vendor's history newest-first and stops at the first page
// with nothing new or changed — so the first run fetches everything and a
// later sync stops as soon as it reaches orders it already has (an order read
// while on its way is updated once delivered). Orders are stored with
// line items only (instamart-parse.ts drops the address, phone and name).
//
// Packs: the vendor's order data has no pack size, so each SKU is looked up
// in the catalog, most-bought first (those drive predictions — "ready to use"
// comes early). SKUs any household already resolved are skipped: pack sizes
// are product data, not personal.
//
// Every step is idempotent, so a failed or interrupted job is simply run
// again and continues where it stopped. Nothing secret is logged — counts only.
import {
  DEAD_ORDER_STATUSES,
  DELIVERED_STATUS,
  IMPORT_AUTO_SYNC_HOURS,
  IMPORT_CALL_DELAY_MS,
  IMPORT_ON_THE_WAY_SYNC_MINUTES,
  IMPORT_ETA_WINDOW,
  IMPORT_MAX_PAGES,
  IMPORT_READY_SKUS,
  IMPORT_STALE_SECONDS,
  VENDOR_PACK_LOOKUP_CALLS,
  type ConnectableVendor,
} from '../../constants.js';
import type { VaultConfig } from '../../config.js';
import type { Db } from '../../db.js';
import { errorFields, type Logger } from '../../logger.js';
import { openSealed, seal } from '../../vault.js';
import type { CapturedSession } from '../connect.js';
import type { VendorAddress } from '../adapters/instamart-catalog.js';
import type { ParsedOrder } from './instamart-parse.js';

export type ImportErrorCode = 'unauthorized' | 'unreachable' | 'internal';

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

// One vendor session restored from the vault, able to page through history
// and look up pack labels. `cursor` is opaque to the runner: Instamart pages
// by a timestamp, Blinkit by the next_url and postback params its own page
// hands back (Appendix A), and the runner only carries it from one page to
// the next.
export interface ImportSession {
  // `packs` are the pack labels this page taught us (sku → label), for a
  // vendor that writes the pack on the order line. They are stored as the
  // page is read, because that reading is the only place they exist: a
  // resumed job, or a sync that finds nothing new, never sees them again.
  listPage(cursor: unknown): Promise<{ orders: ParsedOrder[]; nextCursor: unknown; packs?: { sku: string; storeId: number; label: string }[] }>;
  packLabel(sku: string, storeId: number, name: string): Promise<string | null>; // null = not in the catalog
  // The delivery addresses saved on the account, when this vendor's session
  // can see them without a call of its own. Optional: a vendor that cannot is
  // not a vendor that failed, and a sync must never break over an address.
  addresses?(): Promise<VendorAddress[]>;
  // Whether this session could reach the vendor's own checkout. Optional, and
  // null means "did not look" - which is never read as a no. Only paying
  // depends on it, so it must never fail a sync.
  checkoutReady?(): Promise<boolean | null>;
  // The session as the vendor left it, for a vendor whose login renews itself
  // while it is used (Zepto's access token lasts an hour, Appendix D). Sealed
  // again after a sync that worked, so the vault never keeps a token the
  // vendor has already replaced. Optional; null = nothing to save.
  renewedSession?(): Promise<CapturedSession | null>;
  close(): Promise<void>;
}

export type ImportAdapters = Partial<Record<ConnectableVendor, { open(session: CapturedSession): Promise<ImportSession> }>>;

// What the household can have a cart or an order delivered to (design §19
// stage 1). Taken on every sync because it is free here - the session is open
// and, on Blinkit, the page it needs is the one already loaded - and because
// a list captured once at connect goes stale.
//
// Never fatal. An empty answer leaves whatever is stored alone: a vendor that
// cannot see its addresses today must not erase the ones the household picked
// from yesterday.
async function saveAddresses(deps: ImportDeps, conn: { id: string; vendor: string }, session: ImportSession): Promise<void> {
  if (!session.addresses) return;
  try {
    const found = await session.addresses();
    if (!found.length) return;
    await deps.db.query('update vendor_connections set addresses = $2, updated_at = now() where id = $1', [conn.id, JSON.stringify(found)]);
    deps.logger.info('import: addresses saved', { vendor: conn.vendor, count: found.length });
  } catch {
    // An address is not worth failing a sync over.
  }
}

// Keep the session the vendor renewed during this sync - whether the sync
// then worked or not. Zepto renews on page load and ROTATES the refresh token
// as it does (measured 2026-09-24), so a renewal thrown away with a failed
// sync may leave the vault holding a token the vendor no longer honours, and
// the household logged out over a network hiccup. Only a session the vendor
// refused is not kept: there is nothing in it worth keeping. Never fatal.
async function saveRenewedSession(deps: ImportDeps, conn: { id: string; vendor: string }, session: ImportSession): Promise<void> {
  if (!session.renewedSession || !deps.vault.publicKey) return;
  try {
    const renewed = await session.renewedSession();
    if (!renewed) return;
    const sealed = seal(deps.vault.publicKey, JSON.stringify(renewed), `vendor_connections:${conn.id}:session`);
    await deps.db.query('update vendor_connections set session_sealed = $2, updated_at = now() where id = $1', [conn.id, sealed]);
  } catch {
    deps.logger.warn('import: could not keep the renewed session', { vendor: conn.vendor });
  }
}

// Can this session still pay, as well as read?
//
// Asked on every sync because it is free here and because the answer changes
// without warning: a household whose connection predates the fix that writes
// `user` reads perfectly and is refused at the checkout, and had no way to
// find that out except by trying to buy something (design Appendix A).
//
// Never fatal, and never overwrites a real answer with a shrug.
async function saveCheckoutReady(deps: ImportDeps, conn: { id: string; vendor: string }, session: ImportSession): Promise<void> {
  if (!session.checkoutReady) return;
  try {
    const ready = await session.checkoutReady();
    if (ready === null) return;
    await deps.db.query('update vendor_connections set checkout_ready = $2 where id = $1', [conn.id, ready]);
    if (!ready) deps.logger.info('import: this session cannot reach the checkout', { vendor: conn.vendor });
  } catch {
    // Paying is not worth failing a sync over.
  }
}

export interface ImportDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  adapters: ImportAdapters;
  // Read every page of history, even pages with nothing new (see listOrders).
  relistAll?: boolean;
  // The page limit, for tests. Production uses IMPORT_MAX_PAGES.
  maxPages?: number;
  delayMs?: number; // between vendor calls; tests use 0
  // Fires when the worker shuts down: the job is put back in the queue.
  signal?: AbortSignal;
}

// Thrown between steps when the worker is shutting down.
class Interrupted extends Error {}
const checkpoint = (deps: ImportDeps) => {
  if (deps.signal?.aborted) throw new Interrupted();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Syncs that run by themselves (design §7.10): each connected app every
// IMPORT_AUTO_SYNC_HOURS, and every IMPORT_ON_THE_WAY_SYNC_MINUTES while one of
// its orders is still on its way, so a delivery counts without anyone tapping
// Sync. Only connections that finished a first import (last_sync_at set) and
// have nothing running. Syncs are silent (notify.ts only announces first
// imports). Returns how many were queued.
export async function queueDueSyncs(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `select c.id from vendor_connections c
      where c.status = 'active' and c.last_sync_at is not null
        and not exists (select 1 from import_jobs j where j.connection_id = c.id and j.status in ('queued', 'listing', 'packs'))
        and (c.last_sync_at < now() - make_interval(hours => $1)
             or (c.last_sync_at < now() - make_interval(mins => $2)
                 and exists (select 1 from raw_orders o where o.connection_id = c.id
                              and o.status <> $3 and o.status <> all($4::text[]))))`,
    [IMPORT_AUTO_SYNC_HOURS, IMPORT_ON_THE_WAY_SYNC_MINUTES, DELIVERED_STATUS, DEAD_ORDER_STATUSES],
  );
  for (const r of rows) await queueImport(db, r.id);
  return rows.length;
}

// Queue an import for a connection, or return the one already live.
export async function queueImport(db: Db, connectionId: string): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `insert into import_jobs (household_id, connection_id, vendor, status)
     select household_id, id, vendor, 'queued' from vendor_connections where id = $1
     on conflict (connection_id) where status in ('queued', 'listing', 'packs') do nothing
     returning id`,
    [connectionId],
  );
  const id =
    inserted.rows[0]?.id ??
    (
      await db.query<{ id: string }>(
        `select id from import_jobs where connection_id = $1 and status in ('queued', 'listing', 'packs')`,
        [connectionId],
      )
    ).rows[0]?.id;
  if (!id) throw new Error('could not queue an import: no such connection');
  await db.query(`select pg_notify('import_jobs', $1)`, [id]);
  return id;
}

// Take the next queued job, or one left mid-flight by a worker that stopped.
export async function claimNextImport(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `update import_jobs set status = 'listing', updated_at = now()
      where id = (select id from import_jobs
                   where status = 'queued'
                      or (status in ('listing', 'packs') and updated_at < now() - make_interval(secs => $1))
                   order by created_at limit 1
                   for update skip locked)
    returning id`,
    [IMPORT_STALE_SECONDS],
  );
  return rows[0]?.id ?? null;
}

async function listOrders(deps: ImportDeps, jobId: string, conn: { id: string; household_id: string; vendor: string }, session: ImportSession): Promise<number> {
  const { db } = deps;
  let cursor: unknown = null;
  let stored = 0;
  const maxPages = deps.maxPages ?? IMPORT_MAX_PAGES;
  for (let pageNo = 0; ; pageNo++) {
    if (pageNo >= maxPages) {
      deps.logger.warn('import: page limit reached, stopping', { job: jobId, vendor: conn.vendor, pages: pageNo });
      break;
    }
    checkpoint(deps);
    const page = await session.listPage(cursor);
    if (page.orders.length === 0) break;
    let fresh = 0;
    for (const o of page.orders) {
      // The household is read from the connection on every insert, not from
      // the job: a member who joins another household mid-sync takes their
      // connection with them, and their orders must follow it (design §19).
      // An order already stored is updated when the vendor's copy changed: one
      // read while still on its way (ACTIVE) becomes DELIVERED (or CANCELLED)
      // on a later sync, with its final total and lines. Without this, an
      // order synced mid-delivery never counted.
      const r = await db.query<{ inserted: boolean }>(
        `insert into raw_orders (household_id, connection_id, vendor, vendor_order_id, placed_at, status, total, address_label, address_ref, items)
         select c.household_id, c.id, $2, $3, $4, $5, $6, $7, $8, $9 from vendor_connections c where c.id = $1
         on conflict (connection_id, vendor_order_id) do update
           set status = excluded.status, total = excluded.total, items = excluded.items,
               address_label = excluded.address_label, address_ref = excluded.address_ref
         where raw_orders.status is distinct from excluded.status
            or raw_orders.total is distinct from excluded.total
            or raw_orders.items is distinct from excluded.items
         returning (xmax = 0) as inserted`,
        [conn.id, conn.vendor, o.vendorOrderId, o.placedAt, o.status, o.total, o.addressLabel, o.addressRef, JSON.stringify(o.items)],
      );
      if (r.rows[0]?.inserted) stored++;
      fresh += r.rowCount ?? 0;
    }
    // A label learned here fills a pack we did not know, and replaces one an
    // earlier run could only answer null for. It never overwrites a real
    // label: pack sizes are product data, learned once (design §8).
    for (const pack of page.packs ?? []) {
      await db.query(
        `insert into sku_packs (vendor, store_id, sku, label) values ($1, $2, $3, $4)
         on conflict (vendor, store_id, sku) do update set label = excluded.label
          where sku_packs.label is null`,
        [conn.vendor, pack.storeId, pack.sku, pack.label],
      );
    }
    await db.query(`update import_jobs set orders_done = $2, updated_at = now() where id = $1`, [jobId, stored]);
    // Nothing new or changed on this page: we've reached history we already
    // have. `relistAll` reads on anyway - the one case being a vendor whose
    // pack labels live only in its order pages, where a page with no new
    // order can still carry a pack we never learned.
    if ((fresh === 0 && !deps.relistAll) || page.nextCursor === null || page.nextCursor === undefined) break;
    cursor = page.nextCursor;
    await sleep(deps.delayMs ?? IMPORT_CALL_DELAY_MS);
  }
  return stored;
}

async function resolvePacks(deps: ImportDeps, jobId: string, conn: { id: string; vendor: string }, session: ImportSession): Promise<void> {
  const { db } = deps;
  // SKUs on delivered orders that no household has resolved yet, most-bought first.
  const { rows: needed } = await db.query<{ store_id: string; sku: string; name: string }>(
    `select (i->>'storeId')::bigint as store_id, i->>'sku' as sku, min(i->>'name') as name, count(*) as n
       from raw_orders r, jsonb_array_elements(r.items) i
      where r.connection_id = $1 and r.status = $2
        and not exists (select 1 from sku_packs p
                         where p.vendor = r.vendor and p.store_id = (i->>'storeId')::bigint and p.sku = i->>'sku')
      group by 1, 2
      order by n desc, sku`,
    [conn.id, DELIVERED_STATUS],
  );
  const readyAfter = Math.min(needed.length, IMPORT_READY_SKUS);
  await db.query(
    `update import_jobs set status = 'packs', skus_total = $2, skus_done = 0,
            ready_at = case when $3 then coalesce(ready_at, now()) else ready_at end, updated_at = now()
      where id = $1`,
    [jobId, needed.length, readyAfter === 0],
  );

  const pauseMs = VENDOR_PACK_LOOKUP_CALLS[conn.vendor] === false ? 0 : (deps.delayMs ?? IMPORT_CALL_DELAY_MS);
  const steps: number[] = [];
  for (let i = 0; i < needed.length; i++) {
    checkpoint(deps);
    const s = needed[i];
    const started = Date.now();
    const label = await session.packLabel(s.sku, Number(s.store_id), s.name);
    await db.query(
      `insert into sku_packs (vendor, store_id, sku, label) values ($1, $2, $3, $4)
       on conflict (vendor, store_id, sku) do nothing`,
      [conn.vendor, s.store_id, s.sku, label],
    );
    steps.push(Date.now() - started);
    const done = i + 1;
    await db.query(
      `update import_jobs
          set skus_done = $2, step_ms = $3,
              ready_at = case when $4 then coalesce(ready_at, now()) else ready_at end,
              updated_at = now()
        where id = $1`,
      [jobId, done, steps.slice(-IMPORT_ETA_WINDOW), done >= readyAfter],
    );
    // The pause is there to be polite to the vendor, so it belongs to a call.
    // A vendor whose packs were learned while listing makes none (§7.10).
    if (done < needed.length && pauseMs > 0) await sleep(pauseMs);
  }
}

export async function runImport(deps: ImportDeps, jobId: string): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<{ status: string; connection_id: string; household_id: string; vendor: string; session_sealed: string }>(
    `select j.status, c.id as connection_id, c.household_id, c.vendor, c.session_sealed
       from import_jobs j join vendor_connections c on c.id = j.connection_id
      where j.id = $1`,
    [jobId],
  );
  const job = rows[0];
  if (!job || !['queued', 'listing', 'packs'].includes(job.status)) return;
  const conn = { id: job.connection_id, household_id: job.household_id, vendor: job.vendor };
  const log = { job: jobId, vendor: job.vendor };

  let session: ImportSession | null = null;
  let refused = false;
  try {
    const adapter = deps.adapters[job.vendor as ConnectableVendor];
    if (!adapter) throw new ImportError('internal');
    const captured = JSON.parse(
      openSealed(deps.vault.privateKeys, job.session_sealed, `vendor_connections:${conn.id}:session`),
    ) as CapturedSession;
    session = await adapter.open(captured);

    await db.query(`update import_jobs set status = 'listing', error_code = null, updated_at = now() where id = $1`, [jobId]);
    const stored = await listOrders(deps, jobId, conn, session);
    logger.info('import: orders listed', { ...log, newOrders: stored });

    await resolvePacks(deps, jobId, conn, session);
    await saveAddresses(deps, conn, session);
    await saveCheckoutReady(deps, conn, session);

    await db.query(
      `update import_jobs set status = 'complete', completed_at = now(), ready_at = coalesce(ready_at, now()), updated_at = now()
        where id = $1`,
      [jobId],
    );
    await db.query(`update vendor_connections set last_sync_at = now(), last_error = null, updated_at = now() where id = $1`, [conn.id]);
    logger.info('import: complete', log);
  } catch (err) {
    if (err instanceof Interrupted) {
      // Back in the queue: the next worker picks it up at once and, every step
      // being idempotent, continues where this one stopped.
      await db.query(`update import_jobs set status = 'queued', updated_at = now() where id = $1`, [jobId]);
      logger.info('import: interrupted, re-queued', log);
      return;
    }
    const reason: ImportErrorCode = err instanceof ImportError ? err.code : 'internal';
    if (!(err instanceof ImportError)) logger.error('import: unexpected failure', { ...log, ...errorFields(err) });
    else logger.info('import: stopped', { ...log, reason });
    if (reason === 'unauthorized') {
      refused = true;
      // The vendor no longer accepts the session: the user must reconnect.
      await db.query(`update import_jobs set status = 'needs_reconnect', error_code = $2, updated_at = now() where id = $1`, [jobId, reason]);
      await db.query(`update vendor_connections set status = 'needs_reconnect', last_error = $2, updated_at = now() where id = $1`, [conn.id, reason]);
    } else {
      await db.query(`update import_jobs set status = 'failed', error_code = $2, updated_at = now() where id = $1`, [jobId, reason]);
      await db.query(`update vendor_connections set last_error = $2, updated_at = now() where id = $1`, [conn.id, reason]);
    }
  } finally {
    if (session && !refused) await saveRenewedSession(deps, conn, session);
    await session?.close().catch((err) => logger.warn('import: session close failed', { ...log, ...errorFields(err) }));
  }
}
