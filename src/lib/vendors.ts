// The Grocery apps page, one card per app: whose accounts are connected to
// it, what we hold from each, when each synced, and each recent sync. In a
// household of several people each connects their own account (design §19),
// so a card can hold more than one. Pure; the page only renders it.
import type { SourceId } from '../types';
import type { Connection } from './connect';
import { timeAgo } from './household';
import type { ImportJob } from './imports';
import { memberName } from './members';

export type VendorState = 'connected' | 'syncing' | 'needs_reconnect' | 'stopped' | 'not_connected' | 'coming_soon';
export type AccountState = Extract<VendorState, 'connected' | 'syncing' | 'needs_reconnect' | 'stopped'>;

// One person's connected account on one app.
export interface AccountRow {
  connectionId: string;
  // Whose it is: "Yours", "partner's". null when everyone connected is the
  // viewer (a household of one needs no names).
  who: string | null;
  mine: boolean; // only its owner can reconnect it: the OTP goes to their phone
  state: AccountState;
  phone: string; // "Phone ending 3210"
  data: string; // "120 orders · Oct 2025 to Sep 2026"
  lastSync: string; // "Last synced 19 min ago"
  progress: { text: string; percent: number | null } | null; // while syncing
  note: string | null; // why the last sync stopped, or who can reconnect
  // False when this session reads fine but the app's own checkout refuses it.
  cannotPay: boolean;
  history: string[]; // "Sep 19, 3:10 PM · 1 new order", newest first
  // Where this account's carts are filled (design §19 stage 1): the app's own
  // saved addresses, and the one picked. The app keeps a cart per store.
  addresses: { id: string; label: string; display: string }[];
  cartAddress: { id: string; label: string; chosenByHousehold?: boolean } | null;
}

export interface VendorRow {
  id: SourceId;
  name: string;
  icon: string;
  color: string;
  // The card's chip: its accounts' state (the most urgent one), or whether it
  // can be connected at all.
  state: VendorState;
  accounts: AccountRow[];
  // The viewer can connect their own account to this app.
  canConnect: boolean;
}

const LIVE = ['queued', 'listing', 'packs'];
// The most urgent account state is the card's.
const URGENCY: AccountState[] = ['needs_reconnect', 'stopped', 'syncing', 'connected'];

function monthYear(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', year: 'numeric' }).format(new Date(iso));
}

function when(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function syncLine(s: Connection['syncs'][number], tz: string): string {
  const outcome =
    s.status === 'complete' ? (s.ordersAdded ? plural(s.ordersAdded, 'new order', 'new orders') : 'No new orders')
    : LIVE.includes(s.status) ? 'Running'
    : s.status === 'needs_reconnect' ? 'Needed a reconnect'
    : 'Stopped';
  return `${when(s.startedAt, tz)} · ${outcome}`;
}

function progressOf(j: ImportJob): { text: string; percent: number | null } {
  if (j.skusTotal === null) {
    const text =
      j.status === 'queued' ? 'Starting'
      : j.kind === 'sync' ? 'Checking for new orders'
      : j.ordersDone ? `Reading orders: ${j.ordersDone} so far`
      : 'Reading orders';
    return { text, percent: null };
  }
  return {
    text: `Learning pack sizes: ${j.skusDone} of ${j.skusTotal}`,
    percent: j.skusTotal === 0 ? 100 : Math.floor((j.skusDone / j.skusTotal) * 100),
  };
}

function accountRow(c: Connection, jobs: ImportJob[], named: boolean, now: Date, tz: string): AccountRow {
  // A job belongs to its connection; an older api without connection ids
  // reported one per app.
  const j = jobs.find((x) => (x.connectionId ? x.connectionId === c.id : x.vendor === c.vendor));
  const mine = c.mine ?? true;
  let state: AccountState = 'connected';
  let note: string | null = null;
  if (c.status === 'needs_reconnect' || j?.status === 'needs_reconnect') {
    state = 'needs_reconnect';
    if (!mine) note = `Only ${memberName(c.memberEmail ?? null, false, c.memberName ?? null)} can reconnect it, with the code sent to their phone.`;
  } else if (j && LIVE.includes(j.status)) state = 'syncing';
  else if (j?.status === 'failed') {
    state = 'stopped';
    note = j.errorCode === 'cancelled' ? 'Last sync was cancelled' : 'Last sync stopped part-way';
  }
  // Reading and paying are not the same health. A session can import every
  // order and still be turned away at the app's own checkout, and saying
  // nothing leaves the household to discover it by trying to buy something.
  const cannotPay = c.checkoutReady === false;
  if (cannotPay && !note) {
    note = mine
      ? 'Reading works. Paying needs a fresh connect.'
      : `Reading works. Paying needs ${memberName(c.memberEmail ?? null, false, c.memberName ?? null)} to connect it again.`;
  }
  return {
    connectionId: c.id,
    cannotPay,
    addresses: c.addresses ?? [],
    cartAddress: c.cartAddress ?? null,
    who: named ? (mine ? 'Yours' : `${memberName(c.memberEmail ?? null, false, c.memberName ?? null)}'s`) : null,
    mine,
    state,
    phone: `Phone ending ${c.phoneLast4}`,
    data:
      c.orders && c.firstOrderAt && c.lastOrderAt
        ? `${plural(c.orders, 'order', 'orders')} · ${monthYear(c.firstOrderAt, tz)} to ${monthYear(c.lastOrderAt, tz)}`
        : 'No orders yet',
    lastSync: c.lastSyncAt ? `Last synced ${timeAgo(new Date(c.lastSyncAt), now, tz)}` : 'Not synced yet',
    progress: state === 'syncing' && j ? progressOf(j) : null,
    note,
    history: c.syncs.map((x) => syncLine(x, tz)),
  };
}

export function vendorRows(
  sources: { id: SourceId; name: string; icon: string; color: string }[],
  connections: Connection[],
  jobs: ImportJob[],
  connectable: string[],
  now: Date,
  tz: string,
): VendorRow[] {
  // Names appear once anyone else's account is in the household.
  const named = connections.some((c) => c.mine === false);
  return sources.map((s) => {
    const accounts = connections.filter((c) => c.vendor === s.id).map((c) => accountRow(c, jobs, named, now, tz));
    const available = connectable.includes(s.id);
    const state: VendorState = accounts.length
      ? URGENCY.find((u) => accounts.some((a) => a.state === u))!
      : available ? 'not_connected' : 'coming_soon';
    return {
      id: s.id,
      name: s.name,
      icon: s.icon,
      color: s.color,
      state,
      accounts,
      canConnect: available && !accounts.some((a) => a.mine),
    };
  });
}
