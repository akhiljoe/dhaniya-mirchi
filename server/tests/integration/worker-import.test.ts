// Importing order history (design §7.10), driven by a FAKE vendor import
// session: pages of orders and pack lookups on demand, failures on cue.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, openSealed, seal } from '../../src/vault.js';
import type { ParsedOrder } from '../../src/worker/import/instamart-parse.js';
import { ImportError, claimNextImport, queueDueSyncs, queueImport, runImport, type ImportAdapters } from '../../src/worker/import/import.js';
import { freshTestDb } from './testdb.js';

const keys = generateVaultKeys();
const vault = { publicKey: keys.publicKey, privateKeys: [keys.privateKey] };
const logLines: string[] = [];
const logger = createLogger({ level: 'debug', write: (l) => logLines.push(l) });
let db: Db;
let householdId: string;
let connectionId: string;

const order = (id: string, day: number, items: [sku: string, store: number, count?: number][], status = 'DELIVERED'): ParsedOrder => ({
  vendorOrderId: id,
  placedAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
  status,
  total: 100,
  addressLabel: 'Home',
  addressRef: 'ref1',
  items: items.map(([sku, storeId, count]) => ({ name: `name of ${sku}`, sku, storeId, count: count ?? 1, pricePaid: 10 })),
});

// A vendor that serves `pages` newest-first, then an empty page.
function fakeVendor(pages: ParsedOrder[][], opts: { packs?: Record<string, string | null>; listPacks?: Record<string, string>; failOn?: 'list' | 'pack'; failWith?: 'unauthorized' | 'unreachable' } = {}) {
  const calls = { pages: 0, packLookups: [] as string[], closed: 0, sessionSeen: null as unknown };
  const adapters: ImportAdapters = {
    instamart: {
      async open(session) {
        calls.sessionSeen = session;
        return {
          async listPage(cursor) {
            if (opts.failOn === 'list') throw new ImportError(opts.failWith ?? 'unreachable');
            const i = typeof cursor === 'number' ? cursor : 0;
            calls.pages++;
            const orders = pages[i] ?? [];
            // A vendor that writes the pack on the order line hands the
            // labels back with the page (Blinkit, design §8).
            const packs = opts.listPacks ? Object.entries(opts.listPacks).map(([sku, label]) => ({ sku, storeId: 0, label })) : undefined;
            return { orders, nextCursor: orders.length ? i + 1 : null, packs };
          },
          async packLabel(sku) {
            calls.packLookups.push(sku);
            if (opts.failOn === 'pack' && calls.packLookups.length === 2) throw new ImportError(opts.failWith ?? 'unreachable');
            // An explicit null means "not in the catalog" — must survive as null.
            return opts.packs && sku in opts.packs ? opts.packs[sku] : '500 g';
          },
          async close() {
            calls.closed++;
          },
        };
      },
    },
  };
  return { adapters, calls };
}

const deps = (adapters: ImportAdapters) => ({ db, logger, vault, adapters, delayMs: 0 });
const job = async (id: string) => (await db.query('select * from import_jobs where id = $1', [id])).rows[0];

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households, sku_packs cascade');
  await db.query(`insert into users (id) values ('sub_a')`);
  householdId = (await db.query(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`)).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_a', 'owner')`, [householdId]);
  connectionId = randomUUID();
  const session = { cookies: [{ name: 'sid', value: 'SESSION-SECRET', domain: '.instamart.in', path: '/' }], localStorage: {} };
  await db.query(
    `insert into vendor_connections (id, household_id, user_id, vendor, phone_last4, session_sealed, status)
     values ($1, $2, 'sub_a', 'instamart', '3210', $3, 'active')`,
    [connectionId, householdId, seal(keys.publicKey, JSON.stringify(session), `vendor_connections:${connectionId}:session`)],
  );
  logLines.length = 0;
});

describe('queueImport', () => {
  it('queues one live job per connection and announces it', async () => {
    const id = await queueImport(db, connectionId);
    expect((await job(id)).status).toBe('queued');
    expect(await queueImport(db, connectionId)).toBe(id); // already live → same job
  });
});

describe('runImport', () => {
  it('fetches every page, stores orders without personal data, resolves packs most-bought first', async () => {
    const { adapters, calls } = fakeVendor([
      [order('o3', 12, [['MILK', 1], ['CURD', 1]]), order('o2', 10, [['MILK', 1]])],
      [order('o1', 8, [['MILK', 1], ['RICE', 1, 2]])], // RICE: store 1, count 2
    ]);
    const id = await queueImport(db, connectionId);
    await runImport(deps(adapters), id);

    const j = await job(id);
    expect(j).toMatchObject({ status: 'complete', orders_done: 3, skus_total: 3, skus_done: 3 });
    expect(j.ready_at).not.toBeNull();
    expect(j.completed_at).not.toBeNull();
    expect(calls.closed).toBe(1);
    // Opened with the unsealed session — the worker is the only place that can.
    expect((calls.sessionSeen as { cookies: { value: string }[] }).cookies[0].value).toBe('SESSION-SECRET');

    // MILK is in 3 orders → looked up first.
    expect(calls.packLookups[0]).toBe('MILK');
    const packs = (await db.query('select sku, label from sku_packs order by sku')).rows;
    expect(packs).toEqual([
      { sku: 'CURD', label: '500 g' },
      { sku: 'MILK', label: '500 g' },
      { sku: 'RICE', label: '500 g' },
    ]);

    const rows = (await db.query('select vendor_order_id, address_label, items from raw_orders order by placed_at')).rows;
    expect(rows.map((r) => r.vendor_order_id)).toEqual(['o1', 'o2', 'o3']);
    expect(rows[0].items[1]).toMatchObject({ sku: 'RICE', count: 2 });

    const conn = (await db.query('select last_sync_at from vendor_connections where id = $1', [connectionId])).rows[0];
    expect(conn.last_sync_at).not.toBeNull();
  });

  it('never looks up a SKU another household already resolved', async () => {
    await db.query(`insert into sku_packs (vendor, store_id, sku, label) values ('instamart', 1, 'MILK', '1 l')`);
    const { adapters, calls } = fakeVendor([[order('o1', 8, [['MILK', 1], ['RICE', 1]])]]);
    const id = await queueImport(db, connectionId);
    await runImport(deps(adapters), id);
    expect(calls.packLookups).toEqual(['RICE']);
    expect((await job(id)).skus_total).toBe(1);
  });

  it('records a SKU the catalog does not know as searched-but-unknown, not guessed', async () => {
    const { adapters } = fakeVendor([[order('o1', 8, [['GINGER', 1]])]], { packs: { GINGER: null } });
    await runImport(deps(adapters), await queueImport(db, connectionId));
    expect((await db.query(`select label from sku_packs where sku = 'GINGER'`)).rows[0].label).toBeNull();
  });

  it('resolves packs only for delivered orders', async () => {
    const { adapters, calls } = fakeVendor([[order('o2', 9, [['CHIPS', 1]], 'FAILED'), order('o1', 8, [['MILK', 1]])]]);
    await runImport(deps(adapters), await queueImport(db, connectionId));
    expect(calls.packLookups).toEqual(['MILK']);
  });

  it('marks job and connection needs_reconnect when the session is no longer accepted', async () => {
    const { adapters, calls } = fakeVendor([], { failOn: 'list', failWith: 'unauthorized' });
    const id = await queueImport(db, connectionId);
    await runImport(deps(adapters), id);
    expect(await job(id)).toMatchObject({ status: 'needs_reconnect', error_code: 'unauthorized' });
    expect((await db.query('select status from vendor_connections where id = $1', [connectionId])).rows[0].status).toBe('needs_reconnect');
    expect(calls.closed).toBe(1);
  });

  it('a failed run resumes without redoing finished work', async () => {
    const pages = [[order('o1', 8, [['MILK', 1], ['RICE', 1], ['CURD', 1]])]];
    const first = fakeVendor(pages, { failOn: 'pack' });
    const id = await queueImport(db, connectionId);
    await runImport(deps(first.adapters), id);
    expect(await job(id)).toMatchObject({ status: 'failed', error_code: 'unreachable' });

    const again = fakeVendor(pages);
    const id2 = await queueImport(db, connectionId);
    await runImport(deps(again.adapters), id2);
    expect((await job(id2)).status).toBe('complete');
    // Whatever the first run resolved before failing is not looked up again.
    const resolvedBefore = first.calls.packLookups.slice(0, -1);
    expect(resolvedBefore.length).toBeGreaterThan(0);
    for (const sku of resolvedBefore) expect(again.calls.packLookups).not.toContain(sku);
    expect((await db.query('select count(*)::int as n from raw_orders')).rows[0].n).toBe(1);
  });

  it('a later sync stops at the first page with nothing new', async () => {
    const pages = [[order('o2', 10, [['MILK', 1]])], [order('o1', 8, [['MILK', 1]])]];
    await runImport(deps(fakeVendor(pages).adapters), await queueImport(db, connectionId));
    const later = fakeVendor(pages);
    const id = await queueImport(db, connectionId);
    await runImport(deps(later.adapters), id);
    expect(later.calls.pages).toBe(1);
    expect((await job(id)).orders_done).toBe(0);
  });

  it('updates an order read while on its way once it is delivered, without calling it new', async () => {
    // Synced minutes after ordering: on its way. The next sync: delivered.
    await runImport(deps(fakeVendor([[order('o2', 10, [['MILK', 1]], 'ACTIVE')], [order('o1', 8, [['MILK', 1]])]]).adapters), await queueImport(db, connectionId));
    const later = fakeVendor([[order('o2', 10, [['MILK', 1]])], [order('o1', 8, [['MILK', 1]])]]);
    const id = await queueImport(db, connectionId);
    await runImport(deps(later.adapters), id);
    const { rows } = await db.query(`select vendor_order_id, status from raw_orders order by vendor_order_id`);
    expect(rows).toEqual([
      { vendor_order_id: 'o1', status: 'DELIVERED' },
      { vendor_order_id: 'o2', status: 'DELIVERED' },
    ]);
    expect((await job(id)).orders_done).toBe(0); // an update, not a new order
    expect(later.calls.pages).toBe(2); // a change on page 1: it looked one page further
  });

  it('syncs by itself every few hours, and every half hour while an order is on its way', async () => {
    await runImport(deps(fakeVendor([[order('o1', 8, [['MILK', 1]])]]).adapters), await queueImport(db, connectionId));
    const syncedAgo = (minutes: number) => db.query(`update vendor_connections set last_sync_at = now() - make_interval(mins => $1)`, [minutes]);
    const live = async () => (await db.query(`select count(*)::int as n from import_jobs where status = 'queued'`)).rows[0].n;

    await syncedAgo(40);
    expect(await queueDueSyncs(db)).toBe(0); // all delivered, synced recently
    await db.query(`update raw_orders set status = 'ACTIVE'`);
    expect(await queueDueSyncs(db)).toBe(1); // one on its way: look again after 30 min
    expect(await queueDueSyncs(db)).toBe(0); // never a second while one is queued
    expect(await live()).toBe(1);

    await db.query(`update import_jobs set status = 'complete'`);
    await db.query(`update raw_orders set status = 'DELIVERED'`);
    await syncedAgo(7 * 60);
    expect(await queueDueSyncs(db)).toBe(1); // the regular sync
  });

  it('gives a second connection to the same vendor account its own copy of every order', async () => {
    // Same Instamart account, another household (or the same person signed in
    // under a new account): its import must not see the orders as "already had".
    const pages = [[order('o2', 10, [['MILK', 1]])], [order('o1', 8, [['MILK', 1]])]];
    const first = fakeVendor(pages);
    await runImport(deps(first.adapters), await queueImport(db, connectionId));

    await db.query(`insert into users (id) values ('sub_b')`);
    const otherHousehold = (await db.query(`insert into households (name, timezone) values ('Flat', 'Asia/Kolkata') returning id`)).rows[0].id;
    const otherConnection = randomUUID();
    const session = { cookies: [{ name: 'sid', value: 'S2', domain: '.instamart.in', path: '/' }], localStorage: {} };
    await db.query(
      `insert into vendor_connections (id, household_id, user_id, vendor, phone_last4, session_sealed, status)
       values ($1, $2, 'sub_b', 'instamart', '3210', $3, 'active')`,
      [otherConnection, otherHousehold, seal(keys.publicKey, JSON.stringify(session), `vendor_connections:${otherConnection}:session`)],
    );
    const second = fakeVendor(pages);
    const id = await queueImport(db, otherConnection);
    await runImport(deps(second.adapters), id);

    expect(second.calls.pages).toBe(first.calls.pages); // the whole history, as a first import
    expect((await job(id)).orders_done).toBe(2);
    const theirs = (await db.query('select vendor_order_id from raw_orders where household_id = $1 order by vendor_order_id', [otherHousehold])).rows;
    expect(theirs.map((r) => r.vendor_order_id)).toEqual(['o1', 'o2']);
  });

  it('never logs the session or order contents', async () => {
    const { adapters } = fakeVendor([[order('o1', 8, [['MILK', 1]])]]);
    await runImport(deps(adapters), await queueImport(db, connectionId));
    const all = logLines.join('\n');
    expect(all).not.toContain('SESSION-SECRET');
    expect(all).not.toContain('name of MILK');
  });
});

describe('claimNextImport', () => {
  it('claims a queued job once', async () => {
    const id = await queueImport(db, connectionId);
    const [a, b] = await Promise.all([claimNextImport(db), claimNextImport(db)]);
    expect([a, b].filter(Boolean)).toEqual([id]);
  });

  it('reclaims a job left mid-flight by a crashed worker, but not one still moving', async () => {
    const id = await queueImport(db, connectionId);
    await db.query(`update import_jobs set status = 'packs', updated_at = now() where id = $1`, [id]);
    expect(await claimNextImport(db)).toBeNull();
    await db.query(`update import_jobs set updated_at = now() - interval '1 hour' where id = $1`, [id]);
    expect(await claimNextImport(db)).toBe(id);
  });
});

describe('the import loop', () => {
  it('runs a job as soon as it is announced', async () => {
    const { startImportLoop } = await import('../../src/worker/import/import-loop.js');
    const { testDatabaseUrl } = await import('./testdb.js');
    const { adapters } = fakeVendor([[order('o1', 8, [['MILK', 1]])]]);
    const loop = await startImportLoop(deps(adapters), testDatabaseUrl(), { sweepMs: 60_000 });
    try {
      const id = await queueImport(db, connectionId); // NOTIFY inside
      const end = Date.now() + 3000;
      while ((await job(id)).status !== 'complete' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect((await job(id)).status).toBe('complete');
    } finally {
      await loop.stop();
    }
  });

  it('on shutdown, puts an unfinished import back in the queue so the next worker resumes it at once', async () => {
    const { startImportLoop } = await import('../../src/worker/import/import-loop.js');
    const { testDatabaseUrl } = await import('./testdb.js');
    // Many SKUs, slow lookups: still running when we stop.
    const skus = Array.from({ length: 50 }, (_, i) => [`S${i}`, 1] as [string, number]);
    const { adapters } = fakeVendor([[order('o1', 8, skus)]]);
    const slow: ImportAdapters = {
      instamart: {
        async open(s) {
          const inner = await adapters.instamart!.open(s);
          return { ...inner, packLabel: async (...a) => (await new Promise((r) => setTimeout(r, 30)), inner.packLabel(...a)) };
        },
      },
    };
    const id = await queueImport(db, connectionId);
    const loop = await startImportLoop(deps(slow), testDatabaseUrl(), { sweepMs: 50 });
    const end = Date.now() + 3000;
    while ((await job(id)).skus_done < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await loop.stop();
    const j = await job(id);
    expect(j.status).toBe('queued');
    expect(j.skus_done).toBeLessThan(50);
  });
});

describe('packs a vendor writes on the order line', () => {
  // Blinkit's labels exist only in the pages being read, so they are stored as
  // the page is read. Before this, an import that stopped before the packs
  // step - or a sync that found nothing new - lost them: a real run on
  // 2026-09-20 ended with 634 of 1,005 packs unknown for exactly that reason.
  it('stores them while listing, before any lookup happens', async () => {
    const { adapters } = fakeVendor([[order('o1', 1, [['sku-a', 0]])]], { listPacks: { 'sku-a': '1 kg' } });
    const id = await queueImport(db, connectionId);
    await runImport(deps(adapters), id);
    const { rows } = await db.query(`select label from sku_packs where sku = 'sku-a'`);
    expect(rows[0].label).toBe('1 kg');
  });

  it('fills a pack an earlier run could only answer null for, and never overwrites a real one', async () => {
    await db.query(`insert into sku_packs (vendor, store_id, sku, label) values ('instamart', 0, 'sku-a', null), ('instamart', 0, 'sku-b', '2 kg')`);
    const { adapters } = fakeVendor([[order('o1', 1, [['sku-a', 0], ['sku-b', 0]])]], { listPacks: { 'sku-a': '1 kg', 'sku-b': 'wrong' } });
    const id = await queueImport(db, connectionId);
    await runImport(deps(adapters), id);
    const { rows } = await db.query(`select sku, label from sku_packs where sku in ('sku-a', 'sku-b') order by sku`);
    expect(rows).toEqual([
      { sku: 'sku-a', label: '1 kg' },
      { sku: 'sku-b', label: '2 kg' },
    ]);
  });

  it('relistAll reads on past a page with nothing new, so its packs are still learned', async () => {
    // The real shape of the bug: a first run leaves a pack unknown, and an
    // ordinary sync never reads that order again, so it stays unknown.
    const pages = () => [[order('o1', 1, [['sku-a', 0]])], [order('o2', 2, [['sku-b', 0]])]];
    const first = fakeVendor(pages(), { packs: { 'sku-b': null } });
    await runImport(deps(first.adapters), await queueImport(db, connectionId));
    expect(first.calls.pages).toBeGreaterThan(1);
    expect((await db.query(`select label from sku_packs where sku = 'sku-b'`)).rows[0].label).toBeNull();

    // A sync stops at the first page it already has, so page two is not reread.
    const again = fakeVendor(pages(), { packs: { 'sku-b': null } });
    await runImport(deps(again.adapters), await queueImport(db, connectionId));
    expect(again.calls.pages).toBe(1);
    expect((await db.query(`select label from sku_packs where sku = 'sku-b'`)).rows[0].label).toBeNull();

    // Asked to relist, it reads every page and the pack is finally learned.
    const forced = fakeVendor(pages(), { packs: { 'sku-b': null }, listPacks: { 'sku-b': '3 kg' } });
    await runImport({ ...deps(forced.adapters), relistAll: true }, await queueImport(db, connectionId));
    expect(forced.calls.pages).toBeGreaterThan(1);
    expect((await db.query(`select label from sku_packs where sku = 'sku-b'`)).rows[0].label).toBe('3 kg');
  });
});

describe('the page limit', () => {
  // relistAll removes both of the usual brakes: it does not stop at a page
  // with nothing new, and it trusts the vendor to stop offering pages. A
  // vendor that always answers with another cursor would page forever,
  // calling out the whole time.
  it('stops reading after the page limit, however many pages the vendor offers', async () => {
    let served = 0;
    const adapters: ImportAdapters = {
      instamart: {
        async open() {
          return {
            async listPage(cursor) {
              const i = typeof cursor === 'number' ? cursor : 0;
              served++;
              // Every page is new, and there is always another one.
              return { orders: [order(`endless-${i}`, 1, [['sku-a', 0]])], nextCursor: i + 1 };
            },
            async packLabel() {
              return '500 g';
            },
            async close() {},
          };
        },
      },
    };
    const id = await queueImport(db, connectionId);
    await runImport({ ...deps(adapters), relistAll: true, maxPages: 5 }, id);
    expect(served).toBe(5);
    expect((await job(id)).status).toBe('complete');
  });
});

// Zepto's access token lasts an hour and renews itself while it is used
// (design Appendix D): the session a sync ends with is the one to keep.
describe('a session the vendor renewed', () => {
  const renewed = { cookies: [{ name: 'accessToken', value: 'NEWER-TOKEN', domain: '.zepto.com', path: '/' }], localStorage: {} };
  const sealedNow = async () => {
    const row = (await db.query('select session_sealed from vendor_connections where id = $1', [connectionId])).rows[0];
    return JSON.parse(openSealed([keys.privateKey], row.session_sealed, `vendor_connections:${connectionId}:session`));
  };
  const adaptersWith = (fail: 'unauthorized' | 'unreachable' | null): ImportAdapters => ({
    instamart: {
      async open() {
        return {
          async listPage() {
            if (fail) throw new ImportError(fail);
            return { orders: [], nextCursor: null };
          },
          async packLabel() {
            return null;
          },
          async renewedSession() {
            return renewed;
          },
          async close() {},
        };
      },
    },
  });

  it('is sealed in place of the old one after a sync that worked', async () => {
    const id = await queueImport(db, connectionId);
    await runImport(deps(adaptersWith(null)), id);
    expect((await job(id)).status).toBe('complete');
    expect(await sealedNow()).toEqual(renewed);
    expect(logLines.join('\n')).not.toContain('NEWER-TOKEN');
  });

  // The renewal rotates the refresh token, so losing it with a failed sync
  // could log the household out over a network hiccup.
  it('is kept even when the sync then fails for another reason', async () => {
    const id = await queueImport(db, connectionId);
    await runImport(deps(adaptersWith('unreachable')), id);
    expect((await job(id)).status).toBe('failed');
    expect(await sealedNow()).toEqual(renewed);
  });

  it('is not kept from a sync the vendor refused', async () => {
    const id = await queueImport(db, connectionId);
    await runImport(deps(adaptersWith('unauthorized')), id);
    expect((await sealedNow()).cookies[0].value).toBe('SESSION-SECRET');
  });
});
