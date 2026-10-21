// The browser side of connecting a grocery app (design §7.10). The phone and
// OTP go to our api once — it seals them for the worker — and the page polls
// for progress. The page never talks to the grocery app itself.
import type { SourceId } from '../types';
import { api, ApiError } from './api';
import { ADDRESS_SOURCE_NOTES, CONNECT_ERROR_FALLBACK, CONNECT_ERROR_TEXT, DEFAULT_HOUSEHOLD_NAME } from './constants';

export { ApiError } from './api';

export interface Household {
  id: string;
  name: string;
  timezone: string;
  role: 'owner' | 'member';
}

export type ConnectStatus = 'requested' | 'sending_otp' | 'otp_sent' | 'verifying' | 'connected' | 'failed' | 'expired' | 'cancelled';

export interface ConnectRequest {
  id: string;
  vendor: SourceId;
  status: ConnectStatus;
  phoneLast4: string;
  errorCode: string | null;
}

// The user's household, creating "Home" in the browser's timezone on first use
// — zero setup, renamable later.
export async function ensureHousehold(): Promise<Household> {
  const me = await api<{ household: Household | null }>('GET', '/api/me');
  if (me.household) return me.household;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const created = await api<{ household: Household }>('POST', '/api/households', { name: DEFAULT_HOUSEHOLD_NAME, timezone });
  return created.household;
}

export function startConnect(vendor: SourceId, phone: string): Promise<ConnectRequest> {
  return api('POST', `/api/connect/${vendor}`, { phone });
}

export function getConnectRequest(id: string): Promise<ConnectRequest> {
  return api('GET', `/api/connect/requests/${encodeURIComponent(id)}`);
}

export function submitOtp(id: string, otp: string): Promise<ConnectRequest> {
  return api('POST', `/api/connect/requests/${encodeURIComponent(id)}/otp`, { otp });
}

// Ends this user's in-flight attempt for the app, if any — wrong number, or an
// attempt left open by a reload. Resolves whether there was one to end.
export async function cancelConnect(vendor: SourceId): Promise<boolean> {
  const r = await api<{ cancelled: boolean }>('POST', `/api/connect/${vendor}/cancel`, {});
  return r.cancelled;
}

export function connectErrorText(code: string | null): string {
  return (code && CONNECT_ERROR_TEXT[code]) || CONNECT_ERROR_FALLBACK;
}

export interface Connection {
  id: string;
  vendor: SourceId;
  // Whose account it is (design §19). Only its owner can reconnect it.
  mine?: boolean;
  memberEmail?: string | null;
  memberName?: string | null; // their name, when the household knows it
  phoneLast4: string;
  status: 'active' | 'needs_reconnect' | 'error';
  lastSyncAt: string | null;
  orders: number; // delivered orders stored
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  syncs: { startedAt: string; completedAt: string | null; status: string; ordersAdded: number }[]; // newest first
  // Where its carts are filled (design §19 stage 1): the addresses saved in
  // the app itself, and the one this household picked. The app keeps a cart
  // per store, and the store follows from the address.
  addresses?: { id: string; label: string; display: string }[];
  // `chosenByHousehold` false: our own match from where their orders go, so
  // the page asks rather than assumes.
  cartAddress?: { id: string; label: string; chosenByHousehold?: boolean } | null;
  // Whether this session can still reach the app's own checkout. Null means
  // nobody has looked yet, which is never read as a no: a connection made
  // before the worker started checking has no answer, not a bad one.
  checkoutReady?: boolean | null;
  // The saved cards, by the names the app's own payment screen shows them
  // under (design §19 stage 3). Never a number and never a token. Empty until
  // a payment screen has been read at least once.
  cards?: string[];
  // What this store charges for delivery and the figure it says delivery is
  // free above, as of the last cart read. Both null until the store has said
  // so, and then the app says nothing about delivery at all.
  delivery?: { fee: number | null; freeAbove: number | null };
}

// Which of the app's own saved addresses this household's carts are for.
// Where this household's carts go unless they say otherwise. Kept on the
// household, not in this browser: a choice made on the phone has to hold on
// the laptop, and a reload must not quietly send the next cart elsewhere.
export function setDefaultCartVendor(vendor: string): Promise<{ cartVendor: string }> {
  return api('PATCH', '/api/household', { cartVendor: vendor });
}

// Whether the cart sheet offers what the usual app lacks from the other one.
export function setCartFallback(on: boolean): Promise<{ cartFallback: boolean }> {
  return api('PATCH', '/api/household', { cartFallback: on });
}

export function chooseCartAddress(connectionId: string, addressId: string): Promise<{ cartAddress: { id: string; label: string } }> {
  return api('POST', `/api/connections/${encodeURIComponent(connectionId)}/address`, { addressId });
}

// The household's connected apps. No household yet (403) = none.
export async function fetchConnections(): Promise<Connection[]> {
  try {
    return (await api<{ connections: Connection[] }>('GET', '/api/connections')).connections;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return [];
    throw err;
  }
}

// The addresses a household picks from, most likely first. An app can hold
// dozens - one household had 65 - so the current choice leads, then the ones
// it bothered to name (a short label is a name like "Home"; a long one is the
// street address the app filled in for it).
export interface PickableAddress {
  id: string;
  label: string;
  display: string;
  // Who the vendor says the parcel is for, and where the address came from.
  // Both optional: Instamart says neither, and an address saved on the vendor
  // itself has no source.
  name?: string;
  source?: string;
}

// Whose account this list belongs to, guessed from the list itself: the name
// on most of the addresses. Used only to decide which rows are worth calling
// out as somebody else's, so a wrong guess costs a line of text and nothing
// more. Returns null when there is no majority to find.
export function accountHolderName(addresses: PickableAddress[]): string | null {
  const counts = new Map<string, number>();
  for (const a of addresses) {
    const n = (a.name ?? '').trim();
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  for (const [name, count] of counts) {
    if (count > most) {
      best = name;
      most = count;
    }
  }
  return best;
}

// The one extra line a row is worth, or null for the rows that need none.
//
// The picker's problem is real: this household's Blinkit account holds 39
// addresses across four cities, several of them labelled "Home", two of them
// shared to the account from somebody else's. Label and street alone do not
// tell those apart, and on Blinkit the address chooses the STORE, so picking
// the wrong one fills a cart that can never be delivered.
//
// One line, most useful first: shared from elsewhere, then addressed to
// somebody other than the account holder, then where it came from.
export function addressNote(address: PickableAddress, holder: string | null): string | null {
  const source = (address.source ?? '').trim().toUpperCase();
  if (source === 'SHARED_ADDRESS') return ADDRESS_SOURCE_NOTES.SHARED_ADDRESS;
  const name = (address.name ?? '').trim();
  if (name && holder && name !== holder) return `For ${name}`;
  return ADDRESS_SOURCE_NOTES[source] ?? null;
}

export function rankAddresses<T extends PickableAddress>(addresses: T[], chosenId?: string | null): T[] {
  return [...addresses].sort(
    (x, y) => Number(y.id === chosenId) - Number(x.id === chosenId) || (x.label || 'zz').length - (y.label || 'zz').length,
  );
}

// The recipient's name is searched too: with several rows called "Home", the
// name is often the only word the household remembers about one.
export function matchAddresses<T extends PickableAddress>(addresses: T[], search: string): T[] {
  const q = search.trim().toLowerCase();
  if (!q) return addresses;
  return addresses.filter((a) => `${a.label} ${a.display} ${a.name ?? ''}`.toLowerCase().includes(q));
}
