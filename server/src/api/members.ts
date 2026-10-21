// Adding someone to a household (design §10.1, §19 "Multi-member households").
//
//   GET  /api/household/members                → members (with their connected apps) + pending invites
//   POST /api/household/invites                { email } → invite someone (owner only)
//   POST /api/household/invites/:id/cancel     → withdraw an invite (owner only)
//   POST /api/household/members/:userId/remove → take a member out (owner only)
//   POST /api/household/leave                  → leave (members; the owner can't)
//   POST /api/invites/:id/accept               → join the household that invited you
//   POST /api/invites/:id/decline
//
// An invite names a verified email: only the Google account with that email
// sees it and can accept (users.email is stored only when verified, oidc.ts).
// Each member connects their OWN grocery accounts with their own phone and
// OTP; one person's vendor session is never used for another (design §19).
//
// A member carries their connections and the orders read through them from
// household to household: joining brings their history in, and leaving or
// being removed takes it out again, into a fresh household of their own.
// Nothing is copied, so nothing can be left behind in two places.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PoolClient } from 'pg';

import { emailAllowed, type AuthDeps } from '../auth/routes.js';
import {
  CONNECT_IN_FLIGHT_STATUSES,
  DEFAULT_HOUSEHOLD_NAME,
  EMAIL_PATTERN,
  HOUSEHOLD_MAX_MEMBERS,
  INVITE_TTL_DAYS,
  MAX_BODY_BYTES,
} from '../constants.js';
import type { Db } from '../db.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { householdOf, requireHousehold, requireUser, type Household } from './households.js';

export interface PendingInvite {
  id: string;
  householdName: string;
  invitedBy: string | null; // the inviter's email
  members: number;
}

// Invites waiting for this user: addressed to their verified email, not yet
// expired, from a household they aren't already in.
export async function invitesFor(db: Db, userId: string): Promise<PendingInvite[]> {
  const { rows } = await db.query<{ id: string; household_name: string; invited_by: string | null; members: string }>(
    `select i.id, h.name as household_name, inviter.email as invited_by,
            (select count(*) from household_members m where m.household_id = i.household_id) as members
       from users me
       join household_invites i on i.email = lower(me.email)
       join households h on h.id = i.household_id
       left join users inviter on inviter.id = i.invited_by
      where me.id = $1 and i.expires_at > now()
        and not exists (select 1 from household_members x where x.user_id = me.id and x.household_id = i.household_id)
      order by i.created_at`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, householdName: r.household_name, invitedBy: r.invited_by, members: Number(r.members) }));
}

async function inTransaction<T>(db: Db, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const out = await work(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Move one user — membership, connections, and every order, import and
// connect attempt that hangs off their connections — into `to`. The household
// they leave is deleted once nobody is left in it. Runs inside the caller's
// transaction; the membership row is locked first so two moves of the same
// user can't interleave.
async function moveUser(client: PoolClient, userId: string, to: string, role: 'owner' | 'member'): Promise<void> {
  const { rows: from } = await client.query<{ household_id: string }>(
    'select household_id from household_members where user_id = $1 for update',
    [userId],
  );
  // A connect attempt in flight is saved to the household it started in; the
  // worker reads that when the OTP succeeds. Let it finish first.
  const inFlight = await client.query('select 1 from connect_requests where user_id = $1 and status = any($2::text[])', [
    userId,
    CONNECT_IN_FLIGHT_STATUSES,
  ]);
  if (inFlight.rowCount) throw new HttpError(409, 'Finish connecting your grocery app first, then try again.');

  await client.query('update vendor_connections set household_id = $2, updated_at = now() where user_id = $1', [userId, to]);
  const mine = 'select id from vendor_connections where user_id = $1';
  await client.query(`update raw_orders set household_id = $2 where connection_id in (${mine})`, [userId, to]);
  await client.query(`update import_jobs set household_id = $2 where connection_id in (${mine})`, [userId, to]);
  await client.query('update connect_requests set household_id = $2 where user_id = $1', [userId, to]);
  await client.query('delete from household_members where user_id = $1', [userId]);
  await client.query('insert into household_members (household_id, user_id, role) values ($1, $2, $3)', [to, userId, role]);
  if (from[0] && from[0].household_id !== to) {
    await client.query(
      'delete from households h where h.id = $1 and not exists (select 1 from household_members m where m.household_id = h.id)',
      [from[0].household_id],
    );
  }
}

// A fresh household of their own for someone leaving or removed, in the
// timezone of the one they leave; they are its owner.
async function moveToOwnHousehold(client: PoolClient, userId: string, timezone: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>('insert into households (name, timezone) values ($1, $2) returning id', [
    DEFAULT_HOUSEHOLD_NAME,
    timezone,
  ]);
  await moveUser(client, userId, rows[0].id, 'owner');
}

function requireOwner(household: Household): void {
  if (household.role !== 'owner') throw new HttpError(403, 'Only the household owner can do that.');
}

export async function handleMembers(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { db } = deps;

  if (url.pathname === '/api/household/members' && req.method === 'GET') {
    const { userId, household } = await requireHousehold(deps, req);
    const { rows: members } = await db.query<{ user_id: string; email: string | null; name: string | null; role: 'owner' | 'member'; joined_at: Date }>(
      `select m.user_id, u.email, u.display_name as name, m.role, m.joined_at
         from household_members m join users u on u.id = m.user_id
        where m.household_id = $1
        order by m.role = 'owner' desc, m.joined_at`,
      [household.id],
    );
    // Which apps each member has connected: the vendor and its state only.
    const { rows: apps } = await db.query<{ user_id: string; vendor: string; status: string }>(
      'select user_id, vendor, status from vendor_connections where household_id = $1 order by vendor',
      [household.id],
    );
    const { rows: invites } = await db.query<{ id: string; email: string; created_at: Date; expires_at: Date }>(
      `select id, email, created_at, expires_at from household_invites
        where household_id = $1 and expires_at > now() order by created_at`,
      [household.id],
    );
    sendJson(res, 200, {
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: m.role,
        you: m.user_id === userId,
        joinedAt: m.joined_at.toISOString(),
        apps: apps.filter((a) => a.user_id === m.user_id).map((a) => ({ vendor: a.vendor, status: a.status })),
      })),
      // Pending invites are shown to every member; only the owner can change them.
      invites: invites.map((i) => ({ id: i.id, email: i.email, createdAt: i.created_at.toISOString(), expiresAt: i.expires_at.toISOString() })),
    });
    return true;
  }

  if (url.pathname === '/api/household/invites' && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    requireOwner(household);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter an email address.');
    // With sign-in on, only allowlisted emails can sign in at all: an invite
    // they could never open helps nobody.
    if (deps.config.auth.enabled && !emailAllowed(deps.config, email)) {
      throw new HttpError(400, "That email isn't on this site's sign-in list yet. Add it there first.");
    }
    const invite = await inTransaction(db, async (client) => {
      // Serialise invites per household, so the member cap holds.
      await client.query('select id from households where id = $1 for update', [household.id]);
      const member = await client.query(
        `select 1 from household_members m join users u on u.id = m.user_id where m.household_id = $1 and lower(u.email) = $2`,
        [household.id, email],
      );
      if (member.rowCount) throw new HttpError(409, 'They are already in your household.');
      const { rows: counts } = await client.query<{ n: string }>(
        `select (select count(*) from household_members where household_id = $1)
              + (select count(*) from household_invites where household_id = $1 and expires_at > now() and email <> $2) as n`,
        [household.id, email],
      );
      if (Number(counts[0].n) >= HOUSEHOLD_MAX_MEMBERS) throw new HttpError(409, `A household can have up to ${HOUSEHOLD_MAX_MEMBERS} people.`);
      const { rows } = await client.query<{ id: string; created_at: Date; expires_at: Date }>(
        `insert into household_invites (household_id, email, invited_by, expires_at)
         values ($1, $2, $3, now() + make_interval(days => $4))
         on conflict (household_id, email) do update
           set invited_by = excluded.invited_by, created_at = now(), expires_at = excluded.expires_at
         returning id, created_at, expires_at`,
        [household.id, email, userId, INVITE_TTL_DAYS],
      );
      return rows[0];
    });
    deps.logger.info('household invite sent', { household: household.id });
    sendJson(res, 201, { invite: { id: invite.id, email, createdAt: invite.created_at.toISOString(), expiresAt: invite.expires_at.toISOString() } });
    return true;
  }

  const cancel = url.pathname.match(/^\/api\/household\/invites\/([0-9a-f-]{36})\/cancel$/);
  if (cancel && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    requireOwner(household);
    const { rowCount } = await db.query('delete from household_invites where id = $1 and household_id = $2', [cancel[1], household.id]);
    if (!rowCount) throw new HttpError(404, 'No such invite.');
    sendJson(res, 200, { cancelled: true });
    return true;
  }

  const remove = url.pathname.match(/^\/api\/household\/members\/([^/]+)\/remove$/);
  if (remove && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    requireOwner(household);
    const target = decodeURIComponent(remove[1]);
    if (target === userId) throw new HttpError(400, "You can't remove yourself. You own this household.");
    await inTransaction(db, async (client) => {
      const found = await client.query('select 1 from household_members where household_id = $1 and user_id = $2', [household.id, target]);
      if (!found.rowCount) throw new HttpError(404, 'They are not in your household.');
      await moveToOwnHousehold(client, target, household.timezone);
    });
    deps.logger.info('household member removed', { household: household.id });
    sendJson(res, 200, { removed: true });
    return true;
  }

  if (url.pathname === '/api/household/leave' && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    if (household.role === 'owner') throw new HttpError(409, "The owner can't leave. Remove the other members instead.");
    await inTransaction(db, (client) => moveToOwnHousehold(client, userId, household.timezone));
    deps.logger.info('household member left', { household: household.id });
    sendJson(res, 200, { household: await householdOf(deps, userId) });
    return true;
  }

  const answer = url.pathname.match(/^\/api\/invites\/([0-9a-f-]{36})\/(accept|decline)$/);
  if (answer && req.method === 'POST') {
    const userId = await requireUser(deps, req);
    const [, inviteId, action] = answer;
    // Only an invite addressed to this user's verified email, and still open.
    const { rows } = await db.query<{ household_id: string }>(
      `select i.household_id from household_invites i join users me on i.email = lower(me.email)
        where i.id = $1 and me.id = $2 and i.expires_at > now()`,
      [inviteId, userId],
    );
    if (!rows.length) throw new HttpError(404, 'That invite has expired or was withdrawn.');
    const to = rows[0].household_id;

    if (action === 'decline') {
      await db.query('delete from household_invites where id = $1', [inviteId]);
      sendJson(res, 200, { declined: true });
      return true;
    }

    await inTransaction(db, async (client) => {
      const current = await client.query<{ household_id: string; role: string; others: string }>(
        `select m.household_id, m.role,
                (select count(*) from household_members o where o.household_id = m.household_id and o.user_id <> m.user_id) as others
           from household_members m where m.user_id = $1`,
        [userId],
      );
      const here = current.rows[0];
      // Owning a household others still live in: moving would leave them
      // without an owner. They leave (or are removed) first.
      if (here && here.household_id !== to && here.role === 'owner' && Number(here.others) > 0) {
        throw new HttpError(409, 'Others are in your household. Remove them first, then join.');
      }
      if (!here || here.household_id !== to) await moveUser(client, userId, to, 'member');
      await client.query('delete from household_invites where id = $1', [inviteId]);
    });
    deps.logger.info('household invite accepted', { household: to });
    sendJson(res, 200, { household: await householdOf(deps, userId) });
    return true;
  }

  return false;
}
