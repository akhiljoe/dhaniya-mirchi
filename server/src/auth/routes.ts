// The sign-in routes (design §14.3). Adapted from an earlier project's
// accounts/routes.ts.
//
//   GET  /auth/start     mint state + nonce + PKCE verifier, redirect to Cognito
//   GET  /auth/callback  verify state, exchange the code, check the allowlist,
//                        mint a session, redirect home
//   GET  /auth/session   is this browser signed in
//   POST /auth/signout   revoke this browser's session
//
// state, nonce and the PKCE verifier ride one short-lived httpOnly cookie
// between start and callback — no server-side store needed for something
// already bound to one browser for ten minutes. It is cleared on the callback
// whatever the outcome, so state is single-use.
//   state          proves the callback belongs to a flow THIS browser began
//                  (without it: login CSRF — the victim signed into the
//                  attacker's account, then connecting their grocery apps to it).
//   nonce          proves the id token was minted for this flow (no replay).
//   code_verifier  proves whoever redeems the code started the flow.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Config } from '../config.js';
import {
  CALLBACK_REPEAT_WINDOW_MS,
  FLOW_COOKIE_INSECURE,
  FLOW_COOKIE_SECURE,
  FLOW_TTL_SECONDS,
  SESSION_COOKIE_INSECURE,
  SESSION_COOKIE_SECURE,
  SESSION_TTL_SECONDS,
} from '../constants.js';
import type { Db } from '../db.js';
import { noContent, parseCookies, redirect, sendJson, serializeCookie } from '../http.js';
import { errorFields, type Logger } from '../logger.js';
import { linkHouseholdsByEmail } from './link.js';
import { TokenError, type OidcClient } from './oidc.js';
import { mintSession, resolveSession, revokeSession, userForSubject } from './sessions.js';

export interface AuthDeps {
  config: Config;
  logger: Logger;
  db: Db;
  oidc: OidcClient | null; // null when sign-in is disabled
}

export function cookieNames(config: Config): { flow: string; session: string } {
  const secure = config.auth.secureCookies;
  return {
    flow: secure ? FLOW_COOKIE_SECURE : FLOW_COOKIE_INSECURE,
    session: secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_INSECURE,
  };
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// What a callback came to: a session token, or the outcome that stopped it.
type CallbackResult = { token: string } | { outcome: string };

// Callbacks in flight or just finished, per sign-in client, by a hash of
// their state and code, so a browser repeating the same callback gets the same
// result (see CALLBACK_REPEAT_WINDOW_MS). Only a request carrying the same flow
// cookie (checked before this is consulted) and the same code finds an entry.
const recentCallbacks = new WeakMap<OidcClient, Map<string, Promise<CallbackResult>>>();

function once(oidc: OidcClient, key: string, run: () => Promise<CallbackResult>): Promise<CallbackResult> {
  let recent = recentCallbacks.get(oidc);
  if (!recent) recentCallbacks.set(oidc, (recent = new Map()));
  const seen = recent.get(key);
  if (seen) return seen;
  const result = run();
  recent.set(key, result);
  const forget = recent;
  setTimeout(() => forget.delete(key), CALLBACK_REPEAT_WINDOW_MS).unref();
  return result;
}

// The configured redirect URI for the address this request came in on
// (localhost, a dev tunnel, the real domain); the first when none matches.
// Only ever a configured one — the Host header only picks among them.
function redirectFor(config: Config, req: IncomingMessage): number {
  const host = req.headers.host ?? '';
  const i = config.auth.redirectUris.findIndex((u) => new URL(u).host === host);
  return i === -1 ? 0 : i;
}

// Is this verified email on AUTH_ALLOWED_EMAILS? No email (unverified, or
// none given) is never allowed. Case-insensitive, as email addresses are.
export function emailAllowed(config: Config, email: string | null): boolean {
  return email !== null && config.auth.allowedEmails.includes(email.toLowerCase());
}

// The user id for this request's session cookie, or null. Every /api route
// that touches household data starts here (then checks household membership).
// With sign-in on, the account's email must still be on the allowlist, so
// taking someone off it ends their existing sessions on their next request.
export async function currentUser(deps: AuthDeps, req: IncomingMessage): Promise<string | null> {
  const token = parseCookies(req)[cookieNames(deps.config).session] ?? '';
  const r = await resolveSession(deps.db, deps.logger, token);
  if (!r.ok) return null;
  if (deps.config.auth.enabled && !emailAllowed(deps.config, r.email)) return null;
  return r.userId;
}

export async function handleAuth(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { config, logger, db, oidc } = deps;
  if (!config.auth.enabled || !oidc) {
    sendJson(res, 503, { error: 'sign-in is not configured' });
    return;
  }
  const names = cookieNames(config);
  const secure = config.auth.secureCookies;
  const clearFlow = serializeCookie(names.flow, '', { maxAgeSeconds: 0, secure });
  const home = config.auth.returnUrl;

  switch (url.pathname) {
    case '/auth/start': {
      // Which address to come back to rides the flow cookie with the rest.
      const which = redirectFor(config, req);
      const flow = oidc.start(config.auth.redirectUris[which]);
      const value = [flow.state, flow.nonce, flow.codeVerifier, which].join('.');
      redirect(res, flow.authorizeUrl, [serializeCookie(names.flow, value, { maxAgeSeconds: FLOW_TTL_SECONDS, secure })]);
      return;
    }

    case '/auth/callback': {
      const fail = (outcome: string) => {
        logger.info('sign-in did not complete', { outcome });
        const shown = outcome === 'cancelled' || outcome === 'not_allowed' ? outcome : 'failed';
        redirect(res, `${home}?signin=${shown}`, [clearFlow]);
      };
      const [state, nonce, verifier, which] = (parseCookies(req)[names.flow] ?? '').split('.');
      const returnTo = config.auth.redirectUris[Number(which)] ?? config.auth.redirectUris[0];
      const gotState = url.searchParams.get('state') ?? '';
      if (!state || !nonce || !verifier || !sameSecret(state, gotState)) return fail('flow_mismatch');
      if (url.searchParams.get('error')) return fail('cancelled');
      const code = url.searchParams.get('code') ?? '';
      if (!code) return fail('no_code');

      const key = createHash('sha256').update(`${state}.${code}`).digest('base64url');
      const result = await once(oidc, key, async (): Promise<CallbackResult> => {
        let identity;
        try {
          identity = await oidc.exchange(code, verifier, nonce, returnTo);
        } catch (err) {
          if (err instanceof TokenError) return { outcome: 'token_error' };
          logger.error('sign-in exchange failed', errorFields(err));
          return { outcome: 'error' };
        }
        // Checked before any user row exists: a stranger leaves nothing behind.
        if (!emailAllowed(config, identity.email)) return { outcome: 'not_allowed' };
        const user = await userForSubject(db, logger, identity.subject, identity.email, identity.picture, identity.givenName);
        if (!user.ok) return { outcome: `user_${user.reason}` };
        await linkHouseholdsByEmail(db, logger, user.userId);
        const token = await mintSession(db, logger, user.userId);
        if (!token) return { outcome: 'no_session' };
        if (user.created) logger.info('new user signed in');
        return { token };
      });
      if ('outcome' in result) return fail(result.outcome);
      redirect(res, home, [clearFlow, serializeCookie(names.session, result.token, { maxAgeSeconds: SESSION_TTL_SECONDS, secure })]);
      return;
    }

    case '/auth/session': {
      const userId = await currentUser(deps, req);
      sendJson(res, 200, userId ? { signedIn: true, userId } : { signedIn: false });
      return;
    }

    case '/auth/signout': {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        sendJson(res, 405, { error: 'use POST' });
        return;
      }
      await revokeSession(db, logger, parseCookies(req)[names.session] ?? '');
      noContent(res, [serializeCookie(names.session, '', { maxAgeSeconds: 0, secure })]);
      return;
    }

    default:
      sendJson(res, 404, { error: 'not found' });
  }
}
