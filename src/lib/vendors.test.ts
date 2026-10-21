// What each grocery app's card on the Grocery apps page says: connected or
// not, what we hold from it, when it synced, and each recent sync.
import { describe, expect, it } from 'vitest';

import type { Connection } from './connect';
import type { ImportJob } from './imports';
import { vendorRows } from './vendors';

const NOW = new Date('2026-09-19T10:00:00Z');
const TZ = 'Asia/Kolkata';
const SOURCES = [
  { id: 'instamart' as const, name: 'Swiggy Instamart', icon: '🛍️', color: '#fc8019' },
  { id: 'blinkit' as const, name: 'Blinkit', icon: '⚡', color: '#f8cb46' },
];

function conn(fields: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    vendor: 'instamart',
    phoneLast4: '3210',
    status: 'active',
    lastSyncAt: '2026-09-19T09:41:00Z',
    orders: 120,
    firstOrderAt: '2025-10-02T08:00:00Z',
    lastOrderAt: '2026-09-18T08:00:00Z',
    syncs: [
      { startedAt: '2026-09-19T09:40:00Z', completedAt: '2026-09-19T09:41:00Z', status: 'complete', ordersAdded: 1 },
      { startedAt: '2026-09-18T22:11:00Z', completedAt: null, status: 'failed', ordersAdded: 0 },
    ],
    ...fields,
  };
}

function job(fields: Partial<ImportJob>): ImportJob {
  return {
    vendor: 'instamart',
    status: 'packs',
    ordersDone: 120,
    skusTotal: 596,
    skusDone: 145,
    readyAt: null,
    completedAt: null,
    errorCode: null,
    startedAt: '2026-09-19T09:50:00Z',
    estimate: null,
    ...fields,
  };
}

const rows = (connections: Connection[], jobs: ImportJob[] = [], connectable = ['instamart']) =>
  vendorRows(SOURCES, connections, jobs, connectable, NOW, TZ);

const account = (connections: Connection[], jobs: ImportJob[] = []) => rows(connections, jobs)[0].accounts[0];

describe('vendorRows', () => {
  it('describes a connected app: number, what we hold, last sync, and its sync history', () => {
    const [r] = rows([conn()]);
    expect(r).toMatchObject({ id: 'instamart', state: 'connected', canConnect: false });
    expect(r.accounts[0]).toMatchObject({
      who: null, // a household of one needs no names
      mine: true,
      state: 'connected',
      phone: 'Phone ending 3210',
      data: '120 orders · Oct 2025 to Sep 2026',
      lastSync: 'Last synced 19 min ago',
    });
    expect(r.accounts[0].history).toEqual(['Sep 19, 3:10 PM · 1 new order', 'Sep 19, 3:41 AM · Stopped']);
    const quiet = conn({ syncs: [{ startedAt: '2026-09-19T09:40:00Z', completedAt: '2026-09-19T09:41:00Z', status: 'complete', ordersAdded: 0 }] });
    expect(rows([quiet])[0].accounts[0].history).toEqual(['Sep 19, 3:10 PM · No new orders']);
  });

  it('shows a running sync with what it is doing', () => {
    expect(account([conn()], [job({ kind: 'first', status: 'listing', ordersDone: 120, skusTotal: null, skusDone: 0 })])).toMatchObject({
      state: 'syncing',
      progress: { text: 'Reading orders: 120 so far', percent: null },
    });
    // Never "0 found": a sync is checking for new orders.
    expect(account([conn()], [job({ kind: 'sync', status: 'listing', ordersDone: 0, skusTotal: null, skusDone: 0 })]).progress).toEqual({
      text: 'Checking for new orders',
      percent: null,
    });
    expect(account([conn()], [job({})])).toMatchObject({
      state: 'syncing',
      progress: { text: 'Learning pack sizes: 145 of 596', percent: 24 },
    });
  });

  it('asks for a reconnect when the app logged us out', () => {
    expect(account([conn({ status: 'needs_reconnect' })]).state).toBe('needs_reconnect');
    expect(rows([conn({ status: 'needs_reconnect' })])[0].state).toBe('needs_reconnect');
  });

  it('says so when the last sync stopped', () => {
    expect(account([conn()], [job({ status: 'failed', errorCode: 'cancelled' })])).toMatchObject({ state: 'stopped', note: 'Last sync was cancelled' });
    expect(account([conn()], [job({ status: 'failed', errorCode: 'unreachable' })])).toMatchObject({ state: 'stopped', note: 'Last sync stopped part-way' });
  });

  it('lists apps not connected yet, and apps we cannot connect yet', () => {
    const [instamart, blinkit] = rows([]);
    expect(instamart).toMatchObject({ state: 'not_connected', accounts: [], canConnect: true });
    expect(blinkit).toMatchObject({ state: 'coming_soon', canConnect: false });
  });

  it('words an app with nothing stored yet', () => {
    expect(account([conn({ orders: 0, firstOrderAt: null, lastOrderAt: null, lastSyncAt: null, syncs: [] })])).toMatchObject({
      data: 'No orders yet',
      lastSync: 'Not synced yet',
    });
  });
});

describe('vendorRows — a household of several people (design §19)', () => {
  const mine = conn({ id: 'c1', mine: true, memberEmail: 'me@gmail.com' });
  const hers = conn({ id: 'c2', mine: false, memberEmail: 'partner@gmail.com', phoneLast4: '4321', orders: 90 });

  it("names whose account each one is, and lets the viewer connect their own when they haven't", () => {
    const [r] = rows([mine, hers]);
    expect(r.accounts.map((a) => [a.who, a.phone])).toEqual([
      ['Yours', 'Phone ending 3210'],
      ["partner's", 'Phone ending 4321'],
    ]);
    expect(r.canConnect).toBe(false);
    expect(rows([hers])[0]).toMatchObject({ state: 'connected', canConnect: true });
  });

  it("tells the viewer who can reconnect someone else's account", () => {
    const a = rows([mine, { ...hers, status: 'needs_reconnect' }])[0];
    expect(a.state).toBe('needs_reconnect'); // the most urgent account sets the chip
    expect(a.accounts[1]).toMatchObject({ mine: false, state: 'needs_reconnect', note: 'Only partner can reconnect it, with the code sent to their phone.' });
  });

  it("matches each import to its own connection", () => {
    const [r] = rows([mine, hers], [job({ connectionId: 'c2', status: 'listing', skusTotal: null })]);
    expect(r.accounts.map((a) => a.state)).toEqual(['connected', 'syncing']);
  });
});
