// Users and browser sessions (design §14.3). Adapted from an earlier project's
// accounts/credentials.ts.
//
// A session token is a bearer credential: 256 random bits, handed to the
// browser once in an httpOnly cookie. Only its SHA-256 is stored, and the hash
// is the primary key, so a database read yields nothing presentable and a
// lookup is one index probe. Unsalted SHA-256 is right here because the input
// is random — there is no dictionary for a salt to defeat (a password would
// need a KDF; this is not one).
import { createHash } from 'node:crypto';

import { SESSION_TOKEN_MAX_LENGTH, SESSION_TTL_SECONDS } from '../constants.js';
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';
import { randomToken } from './oidc.js';
import { isAllowedPictureUrl } from './picture.js';

const hash = (token: string) => createHash('sha256').update(token).digest();

export type UserResult =
  | { ok: true; userId: string; created: boolean }
  | { ok: false; reason: 'suspended' | 'error' };

// Find or create the user behind a verified OIDC subject. An upsert, because
// two tabs finishing sign-in at once is ordinary. The email is only ever a
// provider-verified one, and a sign-in without one keeps the stored value.
// The picture URL is kept only if it is on the pinned Google photo host.
export async function userForSubject(
  db: Db,
  logger: Logger,
  subject: string,
  email: string | null,
  picture: string | null = null,
  givenName: string | null = null,
): Promise<UserResult> {
  const pictureUrl = picture && isAllowedPictureUrl(picture) ? picture : null;
  try {
    // The name fills in only while empty: a name the person typed on the
    // Household page outlives whatever Google sends on the next sign-in.
    const { rows } = await db.query<{ id: string; status: string; created: boolean }>(
      `insert into users (id, email, picture_url, display_name) values ($1, $2, $3, $4)
       on conflict (id) do update
         set last_seen_at = now(),
             email = coalesce(excluded.email, users.email),
             picture_url = coalesce(excluded.picture_url, users.picture_url),
             display_name = coalesce(users.display_name, excluded.display_name)
       returning id, status, (xmax = 0) as created`,
      [subject, email, pictureUrl, givenName],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'error' };
    if (row.status !== 'active') return { ok: false, reason: 'suspended' };
    return { ok: true, userId: row.id, created: row.created };
  } catch (err) {
    logger.error('could not resolve a user for a subject', errorFields(err));
    return { ok: false, reason: 'error' };
  }
}

// Mint a session and return the plaintext token, once. Expiry is absolute —
// never extended on use — so a stolen cookie ages out.
export async function mintSession(db: Db, logger: Logger, userId: string): Promise<string | null> {
  const token = randomToken();
  try {
    await db.query(
      `insert into sessions (token_hash, user_id, expires_at)
       values ($1, $2, now() + make_interval(secs => $3))`,
      [hash(token), userId, SESSION_TTL_SECONDS],
    );
    return token;
  } catch (err) {
    logger.error('could not mint a session', errorFields(err));
    return null;
  }
}

export type SessionResult =
  | { ok: true; userId: string; email: string | null } // email: verified only, as stored
  | { ok: false; reason: 'absent' | 'unknown' | 'suspended' | 'error' };

// Which user a token belongs to, if it's live. Unknown, revoked and expired
// all answer `unknown`: a caller that can tell "revoked" from "never existed"
// learns a token was once real, and nothing legitimate needs that.
export async function resolveSession(db: Db, logger: Logger, token: string): Promise<SessionResult> {
  if (token === '' || token.length > SESSION_TOKEN_MAX_LENGTH) return { ok: false, reason: 'absent' };
  const tokenHash = hash(token);
  try {
    const { rows } = await db.query<{ user_id: string; status: string; email: string | null }>(
      `select s.user_id, u.status, u.email
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.status !== 'active') return { ok: false, reason: 'suspended' };
    // Bookkeeping only: a successful check must not fail because this didn't land.
    await db.query('update sessions set last_used_at = now() where token_hash = $1', [tokenHash]).catch(() => undefined);
    return { ok: true, userId: row.user_id, email: row.email };
  } catch (err) {
    logger.error('could not resolve a session', errorFields(err));
    return { ok: false, reason: 'error' };
  }
}

// End one browser's session. Marked, not deleted, so a token used after
// sign-out is distinguishable (in the database) from one that never existed.
// Idempotent: the goal — this token no longer works — holds either way.
export async function revokeSession(db: Db, logger: Logger, token: string): Promise<void> {
  if (token === '' || token.length > SESSION_TOKEN_MAX_LENGTH) return;
  try {
    await db.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hash(token)]);
  } catch (err) {
    logger.error('could not revoke a session', errorFields(err));
  }
}
