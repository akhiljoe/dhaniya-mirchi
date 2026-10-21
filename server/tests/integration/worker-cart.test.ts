// Filling a household's real vendor cart, in the worker (design §19 stage 1):
// what each line reports, what is recorded as prompted, and every way it can
// stop. The vendor is a stand-in here; the page driving itself is proven
// against the real account (Appendix C, spike/instamart/cart-fill.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CartSession, CartWant, CartLineResult } from '../../src/worker/adapters/instamart-cart.js';
import { CartError } from '../../src/worker/adapters/instamart-cart.js';
import type { CartState, VendorAddress } from '../../src/worker/adapters/instamart-catalog.js';
import { claimNextCartJob, failStaleCartJobs, runCartJob, type CartDeps } from '../../src/worker/cart.js';
import type { CapturedSession } from '../../src/worker/connect.js';
import { CART_STALE_SECONDS } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, seal } from '../../src/vault.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const keys = generateVaultKeys();
const vault = { publicKey: keys.publicKey, privateKeys: [keys.privateKey] };
const SESSION: CapturedSession = { cookies: [], localStorage: {}, headers: {} } as unknown as CapturedSession;

let db: Db;
let householdId: string;
let connectionId: string;

const serving: CartState = { lines: [], bill: { itemTotal: 48, toPay: 158, delivery: 30, surge: 30, smallCart: 20, other: null, freeDeliveryAbove: null }, serving: true, eta: '23 Mins', message: null, statuses: [2] };

// A stand-in vendor: records what it was asked to do and answers as told.
function fakeAdapter(over: { state?: () => Promise<CartState>; set?: (w: CartWant) => Promise<CartLineResult>; open?: () => Promise<CartSession> } = {}) {
  const asked: { want: CartWant; address: string | null }[] = [];
  const opened: (string | null)[] = [];
  let closed = 0;
  const adapter = {
    asked,
    opened,
    closed: () => closed,
    open: async (_session: CapturedSession, deliverTo: VendorAddress | string | null): Promise<CartSession> => {
      const addressLabel = typeof deliverTo === 'string' ? deliverTo : (deliverTo?.label ?? null);
      opened.push(addressLabel);
      if (over.open) return over.open();
      return {
        address: { id: 'a1', label: addressLabel ?? '', display: '', lat: 0, lng: 0, name: '' },
        addresses: async () => [{ id: 'a1', label: addressLabel ?? '', display: '', lat: 0, lng: 0, name: '' }],
        useAddress: async () => true,
        paymentOptions: async () => [],
        state: over.state ?? (async () => serving),
        set: async (want: CartWant): Promise<CartLineResult> => {
          asked.push({ want, address: addressLabel });
          if (over.set) return over.set(want);
          return { item: want.item, product: want.product, pack: want.pack, wanted: want.qty, inCart: want.qty, state: 'added', price: 24, note: null };
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return adapter;
}
const deps = (adapter: { open: (s: CapturedSession, a: VendorAddress | string | null) => Promise<CartSession> }): CartDeps => ({
  db,
  logger,
  vault,
  adapters: { instamart: adapter },
});

const queue = async (wanted: unknown[]) => {
  const { rows } = await db.query<{ id: string }>(
    `insert into cart_jobs (household_id, connection_id, user_id, vendor, wanted, status)
     values ($1, $2, 'sub_a', 'instamart', $3, 'requested') returning id`,
    [householdId, connectionId, JSON.stringify(wanted)],
  );
  return rows[0].id;
};
const outcome = async (id: string) =>
  (
    await db.query<{ status: string; result: { lines: CartLineResult[]; bill: Record<string, number | null>; message?: string } | null; error_code: string | null }>(
      'select status, result, error_code from cart_jobs where id = $1',
      [id],
    )
  ).rows[0];

const MILK = { item: 'milk', product: 'Nandini Pasteurised Toned Milk', pack: '500 ml', qty: 2 };
const CURD = { item: 'curd', product: 'Milky Mist Set Curd', pack: '1 kg', qty: 1 };

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
  await db.query(`insert into users (id, email) values ('sub_a', 'a@x.com')`);
  householdId = (await db.query<{ id: string }>(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`)).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_a', 'owner')`, [householdId]);
  connectionId = (
    await db.query<{ id: string }>(
      `insert into vendor_connections (household_id, user_id, vendor, status, phone_last4, session_sealed)
       values ($1, 'sub_a', 'instamart', 'active', '4321', $2) returning id`,
      [householdId, seal(vault.publicKey, JSON.stringify(SESSION), `vendor_connections:00000000-0000-0000-0000-000000000000:session`)],
    )
  ).rows[0].id;
  // The seal is bound to the connection's id, so re-seal with the real one.
  await db.query('update vendor_connections set session_sealed = $2 where id = $1', [
    connectionId,
    seal(vault.publicKey, JSON.stringify(SESSION), `vendor_connections:${connectionId}:session`),
  ]);
});

describe('filling the cart', () => {
  it('sets each line and reports what the cart holds, with the vendor’s bill', async () => {
    const adapter = fakeAdapter();
    const id = await queue([MILK, CURD]);
    await runCartJob(deps(adapter), id);
    const r = await outcome(id);
    expect(r.status).toBe('done');
    expect(r.result!.lines.map((l) => [l.item, l.state, l.inCart])).toEqual([
      ['milk', 'added', 2],
      ['curd', 'added', 1],
    ]);
    expect(r.result!.bill).toMatchObject({ toPay: 158, surge: 30 });
    expect(adapter.asked.map((a) => a.want.product)).toEqual([MILK.product, CURD.product]);
    expect(adapter.closed()).toBe(1);
  });

  it('records what it added as prompted, so it stays out of the rate (§9.2)', async () => {
    const id = await queue([MILK, CURD]);
    await runCartJob(
      deps(
        fakeAdapter({
          set: async (w) => ({ item: w.item, product: w.product, pack: w.pack, wanted: w.qty, inCart: w.item === 'milk' ? w.qty : 0, state: w.item === 'milk' ? 'added' : 'out_of_stock', price: 24, note: null }),
        }),
      ),
      id,
    );
    const { rows } = await db.query('select item, product, pack, quantity, vendor from prompted_adds where household_id = $1', [householdId]);
    expect(rows).toEqual([{ item: 'milk', product: MILK.product, pack: '500 ml', quantity: 2, vendor: 'instamart' }]);
  });

  it('passes the household’s usual delivery address to the vendor', async () => {
    await db.query(
      `insert into raw_orders (household_id, connection_id, vendor, vendor_order_id, placed_at, status, items, address_label)
       values ($1, $2, 'instamart', 'o1', now(), 'DELIVERED', '[]'::jsonb, 'Maple Residency')`,
      [householdId, connectionId],
    );
    const adapter = fakeAdapter();
    await runCartJob(deps(adapter), await queue([MILK]));
    expect(adapter.opened).toEqual(['Maple Residency']);
  });

  it('adds nothing when the store is not delivering, and keeps its words', async () => {
    const adapter = fakeAdapter({ state: async () => ({ ...serving, serving: false, eta: null, message: 'Store is closed right now' }) });
    const id = await queue([MILK]);
    await runCartJob(deps(adapter), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'not_serving' });
    expect((await outcome(id)).result).toMatchObject({ message: 'Store is closed right now' });
    expect(adapter.asked).toEqual([]);
    expect((await db.query('select 1 from prompted_adds')).rowCount).toBe(0);
  });

  it('marks the connection for reconnecting when the session is refused', async () => {
    const id = await queue([MILK]);
    await runCartJob(
      deps({
        open: async () => {
          throw new CartError('unauthorized');
        },
      }),
      id,
    );
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'unauthorized' });
    expect((await db.query<{ status: string }>('select status from vendor_connections where id = $1', [connectionId])).rows[0].status).toBe('needs_reconnect');
  });

  it('says so when it cannot tell which address to use', async () => {
    const id = await queue([MILK]);
    await runCartJob(
      deps({
        open: async () => {
          throw new CartError('address_needed');
        },
      }),
      id,
    );
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'address_needed' });
  });

  it('reports a line the vendor could not do, without failing the rest', async () => {
    const id = await queue([MILK, CURD]);
    await runCartJob(
      deps(fakeAdapter({ set: async (w) => ({ item: w.item, product: w.product, pack: w.pack, wanted: w.qty, inCart: 0, state: w.item === 'curd' ? 'not_listed' : 'added', price: null, note: w.item === 'curd' ? 'packs here: 200 g' : null }) })),
      id,
    );
    const r = await outcome(id);
    expect(r.status).toBe('done');
    expect(r.result!.lines.map((l) => l.state)).toEqual(['added', 'not_listed']);
    expect(r.result!.lines[1].note).toBe('packs here: 200 g');
  });

  it('fills a household’s carts one after another, and fails one a stopped worker left running', async () => {
    const first = await queue([MILK]);
    const second = await queue([CURD]);
    expect(await claimNextCartJob(db)).toBe(first);
    // Not the household's second cart while its first is being filled: two
    // at once would fight over the same cart.
    expect(await claimNextCartJob(db)).toBeNull();
    await db.query(`update cart_jobs set status = 'done' where id = $1`, [first]);
    expect(await claimNextCartJob(db)).toBe(second);
    // Back to running, as a stopped worker would have left it.
    await db.query(`update cart_jobs set status = 'running' where id = $1`, [first]);
    await db.query(`update cart_jobs set updated_at = now() - make_interval(secs => $1) where id = $2`, [CART_STALE_SECONDS + 60, first]);
    await failStaleCartJobs(db);
    expect(await outcome(first)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
    expect((await outcome(second)).status).toBe('running');
  });
});
