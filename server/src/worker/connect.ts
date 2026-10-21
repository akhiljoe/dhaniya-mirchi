// The worker's side of connecting a grocery app (design §7.10).
//
//   requested ──claim──▶ sending_otp ──vendor sends SMS──▶ otp_sent
//        ▲                                                   │ user types code (api)
//        │                           wrong code (retry) ◀── verifying
//        └────────────────── attempts left                   │ right code
//                                                            ▼
//                                   connected  (session sealed into vendor_connections)
//   any step ──▶ failed / expired
//   requested / sending_otp / otp_sent ──user──▶ cancelled (api; the worker stops)
//
// One headless session per attempt, kept open from send-OTP to verify —
// vendors keep the login state in that browser session's cookies (Instamart's
// verify call doesn't even resend the number). The phone and OTP are opened
// only here, only in memory, and their sealed copies are cleared when the
// attempt ends. Nothing secret is ever logged: only ids, vendor and status.
import { randomUUID } from 'node:crypto';

import {
  CONNECT_MAX_OTP_ATTEMPTS,
  CONNECT_POLL_MS,
  type ConnectableVendor,
} from '../constants.js';
import type { VaultConfig } from '../config.js';
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';
import { openSealed, seal } from '../vault.js';
import type { VendorAddress } from './adapters/instamart-catalog.js';
import { queueImport } from './import/import.js';

// Codes the UI can explain. Never vendor text, never a token.
// `interrupted`: the worker shut down mid-attempt (its browser went with it).
// `cancelled`: the user cancelled — the api already ended the row.
export type ConnectErrorCode = 'otp_invalid' | 'vendor_rejected' | 'vendor_unreachable' | 'expired' | 'interrupted' | 'cancelled' | 'internal';

export class ConnectError extends Error {
  constructor(readonly code: ConnectErrorCode) {
    super(code);
  }
}

// What the worker keeps to act as the user later: the vendor's cookies and any
// storage the site needs. Sealed as JSON; never logged.
export interface CapturedSession {
  cookies: { name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean }[];
  localStorage: Record<string, string>;
}

// One login attempt in one headless browser session (design §7.4 adapters).
export interface ConnectSession {
  requestOtp(phone: string): Promise<void>;
  submitOtp(otp: string): Promise<CapturedSession>; // throws ConnectError('otp_invalid') on a wrong code
  // The addresses saved in the vendor's app; the household picks the one its
  // groceries come to (design §19 stage 1). Optional: a vendor may not have
  // them, and connecting must not fail over it.
  addresses?(): Promise<VendorAddress[]>;
  close(): Promise<void>;
}

export type ConnectAdapters = Partial<Record<ConnectableVendor, { open(): Promise<ConnectSession> }>>;

export interface ConnectDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  adapters: ConnectAdapters;
  pollMs?: number;
  // Aborted when the worker shuts down: a waiting attempt ends as `interrupted`
  // instead of holding shutdown for up to the attempt's full lifetime.
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Atomically take the oldest waiting request. SKIP LOCKED: two workers never
// get the same one.
export async function claimNextRequest(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `update connect_requests set status = 'sending_otp', updated_at = now()
      where id = (select id from connect_requests
                   where status = 'requested' and expires_at > now()
                   order by created_at limit 1
                   for update skip locked)
    returning id`,
  );
  return rows[0]?.id ?? null;
}

// Attempts left in flight past their deadline — a worker restart mid-attempt,
// say — are expired and their sealed secrets cleared.
export async function expireStaleRequests(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `update connect_requests
        set status = 'expired', error_code = 'expired', phone_sealed = null, otp_sealed = null, updated_at = now()
      where status in ('requested', 'sending_otp', 'otp_sent', 'verifying') and expires_at <= now()`,
  );
  return rowCount ?? 0;
}

async function finish(db: Db, id: string, status: 'connected' | 'failed' | 'expired', errorCode: ConnectErrorCode | null) {
  await db.query(
    `update connect_requests
        set status = $2, error_code = $3, phone_sealed = null, otp_sealed = null, updated_at = now()
      where id = $1 and status <> 'cancelled'`,
    [id, status, errorCode],
  );
}

// Wait for the api to record the user's code; returns it opened.
async function awaitOtp(deps: ConnectDeps, id: string): Promise<string> {
  const poll = deps.pollMs ?? CONNECT_POLL_MS;
  for (;;) {
    if (deps.signal?.aborted) throw new ConnectError('interrupted');
    const { rows } = await deps.db.query<{ status: string; otp_sealed: string | null; expired: boolean }>(
      `select status, otp_sealed, expires_at <= now() as expired from connect_requests where id = $1`,
      [id],
    );
    const row = rows[0];
    if (row?.status === 'cancelled') throw new ConnectError('cancelled');
    if (!row || row.expired) throw new ConnectError('expired');
    if (row.status === 'verifying' && row.otp_sealed) {
      return openSealed(deps.vault.privateKeys, row.otp_sealed, `connect_requests:${id}:otp`);
    }
    await sleep(poll);
  }
}

async function saveConnection(
  deps: ConnectDeps,
  req: { household_id: string; user_id: string; vendor: string; phone_last4: string },
  session: CapturedSession,
  addresses: VendorAddress[] = [],
): Promise<string> {
  if (!deps.vault.publicKey) throw new ConnectError('internal');
  const existing = await deps.db.query<{ id: string }>(
    'select id from vendor_connections where user_id = $1 and vendor = $2',
    [req.user_id, req.vendor],
  );
  const id = existing.rows[0]?.id ?? randomUUID();
  const sealed = seal(deps.vault.publicKey, JSON.stringify(session), `vendor_connections:${id}:session`);
  // With one saved address there is nothing to ask: it is the one. With
  // several, the household picks (the page asks); nothing is guessed here.
  const only = addresses.length === 1 ? addresses[0] : null;
  const chosen = only && { ...only, chosenByHousehold: true };
  await deps.db.query(
    `insert into vendor_connections (id, household_id, user_id, vendor, phone_last4, session_sealed, status, addresses, cart_address)
     values ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
     on conflict (user_id, vendor) do update
       set household_id = excluded.household_id, phone_last4 = excluded.phone_last4,
           session_sealed = excluded.session_sealed, status = 'active', last_error = null, updated_at = now(),
           addresses = excluded.addresses,
           -- a household that already chose keeps its choice
           cart_address = coalesce(vendor_connections.cart_address, excluded.cart_address)`,
    [id, req.household_id, req.user_id, req.vendor, req.phone_last4, sealed, JSON.stringify(addresses), chosen ? JSON.stringify(chosen) : null],
  );
  return id;
}

export async function runConnect(deps: ConnectDeps, id: string): Promise<void> {
  const { db, logger } = deps;
  const { rows } = await db.query<{ household_id: string; user_id: string; vendor: string; phone_last4: string; phone_sealed: string | null }>(
    `update connect_requests set status = 'sending_otp', updated_at = now()
      where id = $1 and status in ('requested', 'sending_otp') and expires_at > now()
    returning household_id, user_id, vendor, phone_last4, phone_sealed`,
    [id],
  );
  const req = rows[0];
  if (!req) return; // taken, finished or expired already
  const log = { request: id, vendor: req.vendor };
  const adapter = deps.adapters[req.vendor as ConnectableVendor];
  if (!adapter || !req.phone_sealed) {
    logger.error('connect: no adapter or phone for request', log);
    await finish(db, id, 'failed', 'internal');
    return;
  }

  let session: ConnectSession | null = null;
  try {
    const phone = openSealed(deps.vault.privateKeys, req.phone_sealed, `connect_requests:${id}:phone`);
    try {
      session = await adapter.open();
    } catch (err) {
      logger.error('connect: could not open a browser session', { ...log, ...errorFields(err) });
      throw new ConnectError('vendor_unreachable');
    }
    await session.requestOtp(phone);
    const sent = await db.query(
      `update connect_requests set status = 'otp_sent', error_code = null, updated_at = now() where id = $1 and status = 'sending_otp'`,
      [id],
    );
    if (!sent.rowCount) throw new ConnectError('cancelled'); // the user cancelled while the code was being sent
    logger.info('connect: otp sent', log);

    for (let attempt = 1; ; attempt++) {
      const otp = await awaitOtp(deps, id);
      try {
        const captured = await session.submitOtp(otp);
        // Asked for while the session is open; connecting never fails over it.
        const addresses = await session.addresses?.().catch(() => [] as VendorAddress[]);
        const connectionId = await saveConnection(deps, req, captured, addresses ?? []);
        // Straight into the first import — queued before the attempt reads
        // `connected`, so the page that moves on to import progress always
        // finds the job.
        await queueImport(db, connectionId);
        await finish(db, id, 'connected', null);
        logger.info('connect: connected', log);
        return;
      } catch (err) {
        if (!(err instanceof ConnectError) || err.code !== 'otp_invalid' || attempt >= CONNECT_MAX_OTP_ATTEMPTS) throw err;
        // Wrong code: forget it and wait for another.
        await db.query(
          `update connect_requests set status = 'otp_sent', otp_sealed = null, error_code = 'otp_invalid', updated_at = now() where id = $1`,
          [id],
        );
        logger.info('connect: wrong code, waiting for another', { ...log, attempt });
      }
    }
  } catch (err) {
    const code: ConnectErrorCode = err instanceof ConnectError ? err.code : 'internal';
    if (code === 'cancelled') {
      logger.info('connect: cancelled by the user', log);
      return;
    }
    if (!(err instanceof ConnectError)) logger.error('connect: unexpected failure', { ...log, ...errorFields(err) });
    else logger.info('connect: did not complete', { ...log, reason: code });
    await finish(db, id, code === 'expired' ? 'expired' : 'failed', code);
  } finally {
    await session?.close().catch((err) => logger.warn('connect: session close failed', { ...log, ...errorFields(err) }));
  }
}
