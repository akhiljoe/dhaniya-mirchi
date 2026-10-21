// The ordering dry run (design §19 stage 2): walking a household's real
// checkout as far as it goes without buying anything.
//
// The rule every test here defends: this never places an order. The vendor
// creates the order BEFORE the money moves, so a dry run that went one call
// further would leave the household with a real unpaid order. The vendor is a
// stand-in here; the walk itself is proven against the real account
// (2026-09-21: milk ₹95, five methods offered, stopped before checkout/order).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CartSession, CartWant, CartLineResult, PaymentOption } from '../../src/worker/adapters/instamart-cart.js';
import { CartError } from '../../src/worker/adapters/instamart-cart.js';
import type { CartState, VendorAddress } from '../../src/worker/adapters/instamart-catalog.js';
import type { CapturedSession } from '../../src/worker/connect.js';
import { orderDryRun, type DryRunDeps } from '../../src/worker/order.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, seal } from '../../src/vault.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const keys = generateVaultKeys();
const vault = { publicKey: keys.publicKey, privateKeys: [keys.privateKey] };
const SESSION: CapturedSession = { cookies: [], localStorage: {}, headers: {} } as unknown as CapturedSession;

const CARD: PaymentOption = { kind: 'card', label: 'Cards', needsPerson: true };
const ON_DELIVERY: PaymentOption = { kind: 'on_delivery', label: 'Pay on Delivery', needsPerson: false };

const milkLine = { name: 'Nandini Pasteurised Toned Milk', sku: 'XC7OWJN2X9', quantity: 1, price: 95 };
const cart = (lines: CartState['lines'], serving = true): CartState => ({
  lines,
  bill: { itemTotal: 95, toPay: 95, delivery: 0, surge: 0, smallCart: 0, other: null, freeDeliveryAbove: null },
  serving,
  eta: '12 Mins',
  message: serving ? null : 'Not delivering right now',
  statuses: [2],
});

let db: Db;
let householdId: string;

// A stand-in vendor that records every call, so a test can say what was NOT
// done as precisely as what was.
function fakeAdapter(over: { states?: CartState[]; options?: PaymentOption[]; open?: () => Promise<CartSession> } = {}) {
  const calls: string[] = [];
  const added: CartWant[] = [];
  const states = [...(over.states ?? [cart([milkLine]), cart([milkLine])])];
  const adapter = {
    calls,
    added,
    open: async (_s: CapturedSession, deliverTo: VendorAddress | string | null): Promise<CartSession> => {
      calls.push('open');
      if (over.open) return over.open();
      const label = typeof deliverTo === 'string' ? deliverTo : (deliverTo?.label ?? null);
      return {
        address: { id: 'a1', label: label ?? '', display: '', lat: 0, lng: 0, name: '' },
        addresses: async () => [],
        useAddress: async () => true,
        paymentOptions: async () => {
          calls.push('paymentOptions');
          return over.options ?? [ON_DELIVERY, CARD];
        },
        state: async () => {
          calls.push('state');
          return states.shift() ?? cart([milkLine]);
        },
        set: async (want: CartWant): Promise<CartLineResult> => {
          calls.push('set');
          added.push(want);
          return { item: want.item, product: 'Nandini Pasteurised Toned Milk', pack: '500 ml', wanted: want.qty, inCart: want.qty, state: 'added', price: 95, note: null };
        },
        close: async () => {
          calls.push('close');
        },
      };
    },
  };
  return adapter;
}

const deps = (adapter: ReturnType<typeof fakeAdapter>): DryRunDeps => ({ db, logger, vault, adapters: { instamart: adapter } });

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
  await db.query(
    `insert into vendor_connections (household_id, user_id, vendor, status, phone_last4, session_sealed)
     values ($1, 'sub_a', 'instamart', 'active', '4567', $2)`,
    [householdId, seal(vault.publicKey, JSON.stringify(SESSION), 'placeholder')],
  );
  // The aad a connection's session is sealed under is its own id, so it has
  // to be resealed once the row exists.
  const { rows } = await db.query<{ id: string }>(`select id from vendor_connections where household_id = $1`, [householdId]);
  await db.query('update vendor_connections set session_sealed = $2 where id = $1', [
    rows[0].id,
    seal(vault.publicKey, JSON.stringify(SESSION), `vendor_connections:${rows[0].id}:session`),
  ]);
});

describe('orderDryRun', () => {
  // The whole point of the command.
  it('never asks the vendor to place anything', async () => {
    const adapter = fakeAdapter();
    expect(await orderDryRun(deps(adapter), { householdId })).toBe(0);
    expect(adapter.calls).toEqual(['open', 'state', 'state', 'paymentOptions', 'close']);
    expect(adapter.added).toEqual([]);
  });

  it('leaves a cart that already has something in it alone', async () => {
    const adapter = fakeAdapter();
    await orderDryRun(deps(adapter), { householdId, add: 'milk' });
    expect(adapter.added).toEqual([]);
  });

  // The page only asks what the account can pay with once there is something
  // to pay for, so an empty cart needs one thing in it - exactly one.
  it('puts one thing in an empty cart, and only when asked', async () => {
    const empty = fakeAdapter({ states: [cart([]), cart([milkLine])] });
    await orderDryRun(deps(empty), { householdId, add: 'milk' });
    expect(empty.added).toHaveLength(1);
    expect(empty.added[0]).toMatchObject({ item: 'milk', qty: 1, match: 'search' });

    const untouched = fakeAdapter({ states: [cart([]), cart([])] });
    await orderDryRun(deps(untouched), { householdId });
    expect(untouched.added).toEqual([]);
  });

  // The question the stage exists to answer: could this order be placed with
  // nobody there? Only a method that needs no person says yes.
  it('reads whether any method needs nobody there', async () => {
    const both = fakeAdapter({ options: [ON_DELIVERY, CARD] });
    expect(await orderDryRun(deps(both), { householdId })).toBe(0);

    // Cards only: every one of them wants a CVV and then the bank's OTP.
    const cardOnly = fakeAdapter({ options: [CARD] });
    expect(await orderDryRun(deps(cardOnly), { householdId })).toBe(0);
  });

  // An unreadable answer is "we do not know", and the command says so by
  // failing rather than reporting that this account cannot pay at all.
  it('fails rather than reporting no way to pay', async () => {
    const silent = fakeAdapter({ options: [] });
    expect(await orderDryRun(deps(silent), { householdId })).toBe(1);
  });

  it('stops without walking when the store is not serving', async () => {
    const closed = fakeAdapter({ states: [cart([], false)] });
    expect(await orderDryRun(deps(closed), { householdId, add: 'milk' })).toBe(1);
    expect(closed.calls).not.toContain('paymentOptions');
    expect(closed.added).toEqual([]);
    expect(closed.calls).toContain('close');
  });

  it('closes the session even when the walk throws', async () => {
    let closed = 0;
    const broken = fakeAdapter({
      open: async () =>
        ({
          address: null,
          addresses: async () => [],
          useAddress: async () => true,
          paymentOptions: async () => [],
          state: async () => {
            throw new CartError('unauthorized');
          },
          set: async () => {
            throw new CartError('unauthorized');
          },
          close: async () => {
            closed++;
          },
        }) as unknown as CartSession,
    });
    expect(await orderDryRun(deps(broken), { householdId })).toBe(2);
    expect(closed).toBe(1);
  });

  it('says so when the household has no connected app', async () => {
    const other = (await db.query<{ id: string }>(`insert into households (name, timezone) values ('Other', 'Asia/Kolkata') returning id`)).rows[0].id;
    expect(await orderDryRun(deps(fakeAdapter()), { householdId: other })).toBe(1);
  });
});
