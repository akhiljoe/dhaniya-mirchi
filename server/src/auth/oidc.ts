// The OIDC seam — the only file that talks to the identity provider (design
// §14.3). Ported from an earlier project (backend/src/accounts/oidc.ts), where it was
// written and tested against the same Cognito pool.
//
// No SDK and no JWT library: building an authorize URL, POSTing a form, and
// verifying an RS256 signature against a JWK is all that's needed, and Node
// does the last natively (`createPublicKey` accepts a JWK). Hand-written
// validation is only acceptable because every check below is tested for its
// FAILING case (tests/oidc.test.ts).
//
// What is checked, and why:
//   alg      RS256 only — `none` and attacker-chosen HS256 are the classic JWT holes.
//   kid      must name a key in the live JWKS; an unknown kid refetches once (rotation).
//   sig      over the exact `header.payload` bytes received, never a re-encoding.
//   iss      must equal the configured issuer — stops tokens from another pool.
//   aud      must equal our client id — stops tokens minted for another client.
//   exp/iat  with a small clock-skew allowance.
//   nonce    must equal the one generated for this flow — stops replay.
// `sub` is read only after all of that passes.
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';

import type { Config } from '../config.js';
import {
  CLOCK_SKEW_SECONDS,
  DISPLAY_NAME_MAX,
  JWKS_MIN_REFETCH_MS,
  JWKS_TIMEOUT_MS,
  OIDC_PROFILE_SCOPE,
  OIDC_SCOPES,
  RANDOM_TOKEN_BYTES,
  TOKEN_TIMEOUT_MS,
} from '../constants.js';
import { errorFields, type Logger } from '../logger.js';

// Messages never interpolate token material.
export class TokenError extends Error {}

export interface StartedFlow {
  authorizeUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

// A name as the pages may show it: trimmed, one line, no control characters,
// and no longer than a row can hold. Anything else is treated as no name.
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > DISPLAY_NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export interface VerifiedIdentity {
  subject: string; // the OIDC `sub`: opaque and stable
  email: string | null; // only when the provider marks it verified
  picture: string | null; // only an https URL; only present with the profile scope
  // Google's given_name, when the provider passed one through. What the pages
  // call this person until they say otherwise (users.display_name).
  givenName: string | null;
}

export interface OidcClient {
  // redirectUri: one of the configured AUTH_REDIRECT_URI list (default: the
  // first). The code must be redeemed with the same one it was issued for.
  start(redirectUri?: string): StartedFlow;
  exchange(code: string, codeVerifier: string, nonce: string, redirectUri?: string): Promise<VerifiedIdentity>;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

export function b64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function randomToken(): string {
  return b64url(randomBytes(RANDOM_TOKEN_BYTES));
}

export function createOidcClient(config: Config, logger: Logger): OidcClient {
  const auth = config.auth;
  let keys: Jwk[] = [];
  let lastFetch = 0;

  async function loadKeys(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && keys.length > 0) return;
    if (force && now - lastFetch < JWKS_MIN_REFETCH_MS) return;
    lastFetch = now;
    const response = await fetch(auth.jwksUrl, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!response.ok) throw new TokenError('could not fetch the provider signing keys');
    const body = (await response.json()) as { keys?: Jwk[] };
    keys = Array.isArray(body.keys) ? body.keys : [];
  }

  async function keyFor(kid: string): Promise<Jwk> {
    await loadKeys(false);
    let found = keys.find((k) => k.kid === kid);
    if (!found) {
      await loadKeys(true); // rotation is routine; rate-limited above
      found = keys.find((k) => k.kid === kid);
    }
    if (!found) throw new TokenError('id token names an unknown signing key');
    return found;
  }

  function verifySignature(key: Jwk, signingInput: string, signature: Buffer): boolean {
    if (key.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string') return false;
    const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(publicKey, signature);
  }

  async function verifyIdToken(token: string, nonce: string): Promise<VerifiedIdentity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('id token is not a well-formed JWT');
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(fromB64url(rawHeader).toString('utf8'));
      claims = JSON.parse(fromB64url(rawPayload).toString('utf8'));
    } catch {
      throw new TokenError('id token is not a well-formed JWT');
    }

    if (header.alg !== 'RS256') throw new TokenError('id token algorithm is not RS256');
    if (typeof header.kid !== 'string') throw new TokenError('id token names an unknown signing key');

    const key = await keyFor(header.kid);
    if (!verifySignature(key, `${rawHeader}.${rawPayload}`, fromB64url(rawSignature))) {
      throw new TokenError('id token signature did not verify');
    }

    if (claims.iss !== auth.issuer) throw new TokenError('id token issuer does not match the configured provider');
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(auth.clientId) : aud === auth.clientId;
    if (!audOk) throw new TokenError('id token audience is not this client');

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
      throw new TokenError('id token has expired');
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > now) {
      throw new TokenError('id token is issued in the future');
    }
    if (claims.nonce !== nonce) throw new TokenError('id token nonce does not match this sign-in');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new TokenError('id token carries no subject');

    // Verified if the provider says so, or if the sign-in came through Google:
    // Cognito does not pass Google's own email_verified on unless mapped, but it
    // stamps federated sign-ins with an `identities` claim no user can set, and
    // Google verifies a Google account's email. A Cognito username/password
    // account carries no such claim, so its unverified email is never trusted
    // (households are linked by email: an unverified one would be a way in).
    const identities = Array.isArray(claims.identities) ? (claims.identities as { providerName?: unknown }[]) : [];
    const viaGoogle = identities.some((i) => i && i.providerName === 'Google');
    const verified = claims.email_verified === true || claims.email_verified === 'true' || viaGoogle;
    const email = typeof claims.email === 'string' && verified ? claims.email : null;
    const picture = typeof claims.picture === 'string' && claims.picture.startsWith('https://') ? claims.picture : null;
    const givenName = cleanName(claims.given_name);
    return { subject: claims.sub, email, picture, givenName };
  }

  // Only ever a configured redirect URI: never one taken from a request.
  const allowedRedirect = (uri: string | undefined): string => {
    if (uri === undefined) return auth.redirectUris[0];
    if (!auth.redirectUris.includes(uri)) throw new Error('redirect URI is not configured');
    return uri;
  };

  return {
    // state, nonce and the PKCE verifier are 256 random bits each. Only the
    // verifier's S256 challenge goes to the provider; the verifier itself
    // rides an httpOnly cookie back to the callback.
    start(redirectUri?: string): StartedFlow {
      const returnTo = allowedRedirect(redirectUri);
      const state = randomToken();
      const nonce = randomToken();
      const codeVerifier = randomToken();
      const challenge = b64url(createHash('sha256').update(codeVerifier).digest());

      const url = new URL(auth.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', auth.clientId);
      url.searchParams.set('redirect_uri', returnTo);
      url.searchParams.set('scope', auth.profilePicture ? `${OIDC_SCOPES} ${OIDC_PROFILE_SCOPE}` : OIDC_SCOPES);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // Straight to one federated IdP, skipping Cognito's hosted form. The IdP
      // must also be ticked on the app client, or Cognito silently shows its
      // email form with "Login option is not available". Operator config only —
      // never read from the request.
      if (auth.identityProvider !== '') {
        url.searchParams.set('identity_provider', auth.identityProvider);
        // Always offer the account chooser — never sign in as whoever used the
        // device last. `select_account`, not `login`.
        url.searchParams.set('prompt', 'select_account');
      }
      return { authorizeUrl: url.toString(), state, nonce, codeVerifier };
    },

    // A confidential client authenticates with HTTP Basic (a secret in a form
    // body is a secret in more logs).
    async exchange(code: string, codeVerifier: string, nonce: string, redirectUri?: string): Promise<VerifiedIdentity> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: auth.clientId,
        code,
        redirect_uri: allowedRedirect(redirectUri),
        code_verifier: codeVerifier,
      });
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (auth.clientSecret !== '') {
        headers.authorization = `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`;
      }

      let response: Response;
      try {
        response = await fetch(auth.tokenUrl, {
          method: 'POST',
          headers,
          body: body.toString(),
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
      } catch (err) {
        // An unreachable provider must not read as a rejected sign-in.
        logger.warn('token endpoint unreachable', errorFields(err));
        throw new TokenError('the identity provider could not be reached');
      }
      if (!response.ok) {
        // The body can echo the code back; only the status is logged.
        logger.warn('token exchange refused', { status: response.status });
        throw new TokenError('the identity provider refused the sign-in');
      }
      const payload = (await response.json()) as { id_token?: unknown };
      if (typeof payload.id_token !== 'string') throw new TokenError('the identity provider returned no id token');
      return verifyIdToken(payload.id_token, nonce);
    },
  };
}
