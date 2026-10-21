/**
 * The id-token validator (design §14.3) — ported from an earlier project, where it was
 * written and proven (backend/tests/unit/oidc.test.ts).
 *
 * Every test here asserts a **rejection**, and that is the point. A validator
 * nobody has watched refuse a bad token is a validator nobody knows is running:
 * the happy path passing proves the signature check works, and proves nothing
 * about whether `iss`, `aud`, `nonce` or `alg` are looked at.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createOidcClient, TokenError } from '../src/auth/oidc.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const ISSUER = 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test';
const CLIENT_ID = 'client_abc';

const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' };

function b64url(value: object | Buffer): string {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token that is valid unless a test deliberately breaks one part of it. */
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signWith: 'good' | 'wrong' = 'good',
): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', kid: KID, ...header });
  const body = b64url({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'sub_12345',
    nonce: 'nonce_ok',
    iat: now,
    exp: now + 300,
    ...claims,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  const key =
    signWith === 'good'
      ? privateKey
      : generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  return `${head}.${body}.${b64url(signer.sign(key))}`;
}

function client(extraEnv: Record<string, string> = {}): ReturnType<typeof createOidcClient> {
  const config = loadConfig({
    AUTH_ENABLED: 'true',
    AUTH_ISSUER: ISSUER,
    AUTH_AUTHORIZE_URL: 'https://auth.example.com/oauth2/authorize',
    AUTH_TOKEN_URL: 'https://auth.example.com/oauth2/token',
    AUTH_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    AUTH_CLIENT_ID: CLIENT_ID,
    AUTH_CLIENT_SECRET: 'secret_abc',
    AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback',
    AUTH_ALLOWED_EMAILS: 'me@example.com',
    AUTH_SECURE_COOKIES: 'false',
    DATABASE_URL: 'postgres://u:p@localhost:5435/db',
    ...extraEnv,
  });
  return createOidcClient(config, createLogger({ level: 'error' }));
}

/** Answers the JWKS fetch and one token exchange, without a network. */
function stubFetch(idToken: string | null, options: { tokenStatus?: number } = {}): void {
  global.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('jwks')) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    if (options.tokenStatus !== undefined && options.tokenStatus !== 200) {
      return new Response('{"error":"invalid_grant"}', { status: options.tokenStatus });
    }
    return new Response(JSON.stringify(idToken === null ? {} : { id_token: idToken }), {
      status: 200,
    });
  }) as typeof fetch;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('starting a sign-in', () => {
  it('sends a PKCE challenge and keeps the verifier', () => {
    const flow = client().start();
    const url = new URL(flow.authorizeUrl);

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    // The verifier itself must never appear in a URL the browser follows: the
    // whole point of PKCE is that only its hash goes to the provider.
    expect(flow.authorizeUrl).not.toContain(flow.codeVerifier);
    expect(url.searchParams.get('code_challenge')).not.toBe(flow.codeVerifier);
  });

  it('returns to the address the sign-in started on, from the configured list only', () => {
    const c = client({ AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback,https://app.dev.example.com/auth/callback' });
    expect(new URL(c.start().authorizeUrl).searchParams.get('redirect_uri')).toBe('http://localhost:8100/auth/callback');
    expect(new URL(c.start('https://app.dev.example.com/auth/callback').authorizeUrl).searchParams.get('redirect_uri')).toBe(
      'https://app.dev.example.com/auth/callback',
    );
    expect(() => c.start('https://evil.example/auth/callback')).toThrow();
  });

  it('redeems the code with the same redirect URI it was issued for', async () => {
    let sent = '';
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({ id_token: token() }), { status: 200 });
    }) as typeof fetch;
    const c = client({ AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback,https://app.dev.example.com/auth/callback' });
    await c.exchange('code_1', 'verifier', 'nonce_ok', 'https://app.dev.example.com/auth/callback');
    expect(new URLSearchParams(sent).get('redirect_uri')).toBe('https://app.dev.example.com/auth/callback');
  });

  it('renders the hosted login form when no IdP is named', () => {
    // The default. Cognito shows its hosted UI, with whatever it is configured
    // to offer, and the parameter is absent rather than empty — an empty
    // `identity_provider` is not the same request.
    const url = new URL(client().start().authorizeUrl);
    expect(url.searchParams.has('identity_provider')).toBe(false);
    // And no `prompt` either. It describes what a federated provider should do
    // with its own chooser, so it travels with the IdP or not at all.
    expect(url.searchParams.has('prompt')).toBe(false);
  });

  it('goes straight to a named IdP, skipping the hosted form', () => {
    /*
     * `identity_provider` makes Cognito issue a second redirect to that IdP
     * instead of rendering its own email and password page. The value is
     * operator configuration and never comes off the request, which is what
     * stops a crafted link pointing somebody's sign-in at an IdP the operator
     * did not choose.
     */
    const url = new URL(client({ AUTH_IDENTITY_PROVIDER: 'Google' }).start().authorizeUrl);
    expect(url.searchParams.get('identity_provider')).toBe('Google');
    /*
     * The account chooser, always. Without it the provider reuses whoever is
     * already signed in on the device and returns with no screen shown — so on
     * a shared machine you are signed in as the last person who used it, having
     * been asked nothing.
     *
     * `select_account`, not `login`: the question is which account, not prove
     * it is you again.
     */
    expect(url.searchParams.get('prompt')).toBe('select_account');
    // Everything else is unchanged: this is one more parameter on the same
    // flow, not a different one.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email');
  });

  it('asks for openid and email, and nothing else', () => {
    // Every extra scope becomes a row in the Privacy Policy's data table with
    // its own retention period, on a service whose claim is that it holds
    // nothing about anybody.
    expect(new URL(client().start().authorizeUrl).searchParams.get('scope')).toBe('openid email');
  });

  it('gives every flow fresh, distinct secrets', () => {
    const a = client().start();
    const b = client().start();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    // 256 bits, base64url — the resume token's reasoning, and why the hash of
    // this needs no salt.
    expect(a.state.length).toBeGreaterThanOrEqual(43);
  });
});

describe('verifying the id token', () => {
  it('accepts a well-formed token and returns the subject', async () => {
    stubFetch(token());
    await expect(client().exchange('code_1', 'verifier', 'nonce_ok')).resolves.toEqual({
      subject: 'sub_12345',
      email: null,
      picture: null,
      givenName: null,
    });
  });

  // The given name is what the pages will call this person, so it is checked
  // where it is read: one line, no control characters, a row's width.
  it('reads a given name and drops one that could not sit in a row', async () => {
    stubFetch(token({ given_name: '  Alex  ' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({ givenName: 'Alex' });
    for (const bad of ['', '   ', 'a'.repeat(41), 'Akhil', 42, null]) {
      stubFetch(token({ given_name: bad }));
      await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({ givenName: null });
    }
  });

  it('reads an https picture and refuses anything else', async () => {
    /*
     * The claim is about to be turned into an outbound request, so its shape is
     * checked where it is read rather than trusted downstream. `avatar.ts`
     * checks the scheme again and pins the host — this is the first of the two,
     * not the only one.
     */
    stubFetch(token({ picture: 'https://lh3.googleusercontent.com/a/abc=s96-c' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({
      picture: 'https://lh3.googleusercontent.com/a/abc=s96-c',
      givenName: null,
    });

    for (const bad of ['http://lh3.googleusercontent.com/a', 'javascript:alert(1)', 42, null]) {
      stubFetch(token({ picture: bad }));
      await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({
        picture: null,
        givenName: null,
      });
    }
  });

  it('trusts the email of a Google sign-in through Cognito, which does not pass Google\'s flag on', async () => {
    // Cognito sets `identities` for a federated sign-in; the user can't.
    stubFetch(token({ email: 'a@gmail.com', email_verified: false, identities: [{ providerName: 'Google', userId: '1' }] }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({ email: 'a@gmail.com' });
  });

  it('does not trust an unverified email from any other kind of account', async () => {
    stubFetch(token({ email: 'a@gmail.com', email_verified: false, identities: [{ providerName: 'SomeSAML', userId: '1' }] }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({ email: null });
    stubFetch(token({ email: 'a@gmail.com' })); // a Cognito username/password account, never verified
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({ email: null });
  });

  it('reads a verified email and ignores an unverified one', async () => {
    stubFetch(token({ email: 'a@example.com', email_verified: true }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({
      email: 'a@example.com',
    });

    // An unverified address is a string the provider did not stand behind.
    stubFetch(token({ email: 'a@example.com', email_verified: false }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({ email: null });
  });

  it('refuses a token signed by a different key', async () => {
    stubFetch(token({}, {}, 'wrong'));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(TokenError);
  });

  it('refuses alg none, and refuses HS256', async () => {
    // The two oldest JWT vulnerabilities. HS256 matters specifically because
    // the signing key would be the *public* key, which is public.
    stubFetch(token({}, { alg: 'none' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/RS256/);

    stubFetch(token({}, { alg: 'HS256' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/RS256/);
  });

  it('refuses a token from another user pool', async () => {
    // Perfectly valid, correctly signed by *someone*, and not our issuer.
    stubFetch(token({ iss: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_other' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/issuer/);
  });

  it('refuses a token minted for another client of the same pool', async () => {
    stubFetch(token({ aud: 'client_someone_else' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/audience/);
  });

  it('accepts an audience array that contains this client', async () => {
    stubFetch(token({ aud: ['client_other', CLIENT_ID] }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).resolves.toMatchObject({
      subject: 'sub_12345',
    });
  });

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    stubFetch(token({ exp: past, iat: past - 300 }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/expired/);
  });

  it('refuses a token issued in the future', async () => {
    const ahead = Math.floor(Date.now() / 1000) + 7200;
    stubFetch(token({ iat: ahead, exp: ahead + 300 }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/future/);
  });

  it('refuses a token whose nonce belongs to another sign-in', async () => {
    // The replay check. Without it, a token captured from any other sign-in
    // against this pool and client is accepted here.
    stubFetch(token({ nonce: 'nonce_from_elsewhere' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/nonce/);
  });

  it('refuses a token naming an unknown signing key', async () => {
    stubFetch(token({}, { kid: 'not-a-key-we-have' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/signing key/);
  });

  it('refuses a token with no subject', async () => {
    stubFetch(token({ sub: '' }));
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/subject/);
  });

  it('refuses anything that is not a three-part JWT', async () => {
    for (const malformed of ['', 'a.b', 'a.b.c.d', 'not-a-token']) {
      stubFetch(malformed);
      await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(TokenError);
    }
  });

  it('distinguishes a refused exchange from an unreachable provider', async () => {
    // They want different responses from an operator: one is a user whose
    // sign-in failed, the other is an outage.
    stubFetch(null, { tokenStatus: 400 });
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/refused/);

    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/could not be reached/);
  });

  it('refuses a response carrying no id token', async () => {
    stubFetch(null);
    await expect(client().exchange('c', 'v', 'nonce_ok')).rejects.toThrow(/no id token/);
  });
});

describe('profile picture scope', () => {
  it('asks for the profile scope only when profile pictures are switched on', () => {
    expect(new URL(client().start().authorizeUrl).searchParams.get('scope')).toBe('openid email');
    expect(new URL(client({ AUTH_PROFILE_PICTURE: 'true' }).start().authorizeUrl).searchParams.get('scope')).toBe('openid email profile');
  });
});
