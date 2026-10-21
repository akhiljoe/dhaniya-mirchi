// The sign-in routes end to end over real HTTP and real Postgres (design
// §14.3). Only the provider exchange is stubbed — it needs the network.
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { TokenError, type OidcClient, type StartedFlow } from '../../src/auth/oidc.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
let db: Db;

const AUTH_ENV = {
  DATABASE_URL: 'postgres://unused', // the app is handed `db` directly
  AUTH_ENABLED: 'true',
  AUTH_ISSUER: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test',
  AUTH_AUTHORIZE_URL: 'https://auth.example.com/oauth2/authorize',
  AUTH_TOKEN_URL: 'https://auth.example.com/oauth2/token',
  AUTH_JWKS_URL: 'https://cognito-idp.ap-south-1.amazonaws.com/pool_test/.well-known/jwks.json',
  AUTH_CLIENT_ID: 'client_abc',
  AUTH_CLIENT_SECRET: 'secret_abc',
  AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback',
  AUTH_ALLOWED_EMAILS: 'me@example.com,friend@gmail.com',
  AUTH_SECURE_COOKIES: 'false',
};

// A provider stand-in: start() returns fixed secrets; exchange() succeeds only
// for the matching code/verifier/nonce, like the real one.
function stubOidc(
  identity: { subject: string; email: string | null; picture: null; givenName: string | null } = { subject: 'sub_google_1', email: 'me@example.com', picture: null, givenName: null },
): OidcClient & { flow: StartedFlow } {
  const flow: StartedFlow = {
    authorizeUrl: 'https://auth.example.com/oauth2/authorize?client_id=client_abc&state=STATE',
    state: 'STATE_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    nonce: 'NONCE_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    codeVerifier: 'VERIFIER_abcdefghijklmnopqrstuvwxyz0123456789',
  };
  return {
    flow,
    start: () => flow,
    exchange: async (code, verifier, nonce) => {
      if (code !== 'good_code' || verifier !== flow.codeVerifier || nonce !== flow.nonce) {
        throw new TokenError('the identity provider refused the sign-in');
      }
      return identity;
    },
  };
}

async function serve(config: Config, oidc: OidcClient | null): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(createApp({ config, logger, db, oidc }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

const get = (url: string, cookie = '') => fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieValue = (res: Response, name: string) =>
  setCookies(res).find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users cascade');
});

describe('health', () => {
  it('reports ok when the database answers', async () => {
    const s = await serve(loadConfig({ DATABASE_URL: 'postgres://unused' }), null);
    const res = await fetch(`${s.base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true });
    await s.close();
  });

  it('answers 404 as JSON for an unknown route', async () => {
    const s = await serve(loadConfig({ DATABASE_URL: 'postgres://unused' }), null);
    const res = await fetch(`${s.base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    await s.close();
  });
});

describe('sign-in disabled', () => {
  it('answers 503 on every /auth route instead of failing strangely', async () => {
    const s = await serve(loadConfig({ DATABASE_URL: 'postgres://unused' }), null);
    for (const path of ['/auth/start', '/auth/callback?code=x&state=y', '/auth/session']) {
      expect((await get(`${s.base}${path}`)).status).toBe(503);
    }
    await s.close();
  });
});

describe('sign-in flow', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  let oidc: ReturnType<typeof stubOidc>;
  beforeEach(async () => {
    oidc = stubOidc();
    s = await serve(loadConfig(AUTH_ENV), oidc);
  });

  it('start redirects to the provider and sets a short-lived httpOnly flow cookie', async () => {
    const res = await get(`${s.base}/auth/start`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(oidc.flow.authorizeUrl);
    const flow = setCookies(res).find((c) => c.startsWith('dm_flow='))!;
    expect(flow).toMatch(/HttpOnly/i);
    expect(flow).toMatch(/SameSite=Lax/i); // must survive the provider's cross-site redirect back
    expect(flow).toMatch(/Max-Age=600/);
    await s.close();
  });

  it('a full sign-in creates the user, sets the session cookie, and lands on the return URL', async () => {
    const start = await get(`${s.base}/auth/start`);
    const flow = cookieValue(start, 'dm_flow')!;
    const cb = await get(`${s.base}/auth/callback?code=good_code&state=${oidc.flow.state}`, `dm_flow=${flow}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/');
    const session = setCookies(cb).find((c) => c.startsWith('dm_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    // The flow cookie is cleared whatever the outcome — state is single-use.
    expect(setCookies(cb).find((c) => c.startsWith('dm_flow='))).toMatch(/Max-Age=0/);

    const { rows } = await db.query('select id, email from users');
    expect(rows).toEqual([{ id: 'sub_google_1', email: 'me@example.com' }]);

    const me = await get(`${s.base}/auth/session`, `dm_session=${cookieValue(cb, 'dm_session')}`);
    expect(await me.json()).toEqual({ signedIn: true, userId: 'sub_google_1' });
    await s.close();
  });

  it('refuses a callback whose state does not match the flow cookie (login CSRF)', async () => {
    const start = await get(`${s.base}/auth/start`);
    const flow = cookieValue(start, 'dm_flow')!;
    const cb = await get(`${s.base}/auth/callback?code=good_code&state=ATTACKER_STATE`, `dm_flow=${flow}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/?signin=failed');
    expect(cookieValue(cb, 'dm_session')).toBeUndefined();
    expect((await db.query('select count(*)::int as n from users')).rows[0].n).toBe(0);
    await s.close();
  });

  it('refuses a callback with no flow cookie at all', async () => {
    const cb = await get(`${s.base}/auth/callback?code=good_code&state=${oidc.flow.state}`);
    expect(cb.headers.get('location')).toBe('/?signin=failed');
    expect(cookieValue(cb, 'dm_session')).toBeUndefined();
    await s.close();
  });

  it('refuses when the provider rejects the code', async () => {
    const start = await get(`${s.base}/auth/start`);
    const flow = cookieValue(start, 'dm_flow')!;
    const cb = await get(`${s.base}/auth/callback?code=bad_code&state=${oidc.flow.state}`, `dm_flow=${flow}`);
    expect(cb.headers.get('location')).toBe('/?signin=failed');
    expect(cookieValue(cb, 'dm_session')).toBeUndefined();
    await s.close();
  });

  it('lands on a cancelled state when the user backs out at the provider', async () => {
    const start = await get(`${s.base}/auth/start`);
    const flow = cookieValue(start, 'dm_flow')!;
    const cb = await get(`${s.base}/auth/callback?error=access_denied&state=${oidc.flow.state}`, `dm_flow=${flow}`);
    expect(cb.headers.get('location')).toBe('/?signin=cancelled');
    await s.close();
  });

  it('session reports signed-out without a valid cookie', async () => {
    expect(await (await get(`${s.base}/auth/session`)).json()).toEqual({ signedIn: false });
    expect(await (await get(`${s.base}/auth/session`, 'dm_session=forged')).json()).toEqual({ signedIn: false });
    await s.close();
  });

  it('sign-out revokes the session and clears the cookie; only POST is accepted', async () => {
    const start = await get(`${s.base}/auth/start`);
    const cb = await get(`${s.base}/auth/callback?code=good_code&state=${oidc.flow.state}`, `dm_flow=${cookieValue(start, 'dm_flow')}`);
    const cookie = `dm_session=${cookieValue(cb, 'dm_session')}`;

    expect((await get(`${s.base}/auth/signout`, cookie)).status).toBe(405);

    const out = await fetch(`${s.base}/auth/signout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(setCookies(out).find((c) => c.startsWith('dm_session='))).toMatch(/Max-Age=0/);
    expect(await (await get(`${s.base}/auth/session`, cookie)).json()).toEqual({ signedIn: false });
    await s.close();
  });
});

describe('secure cookies', () => {
  it('use the __Host- prefix with Secure when secure cookies are on', async () => {
    const s = await serve(loadConfig({ ...AUTH_ENV, AUTH_SECURE_COOKIES: 'true' }), stubOidc());
    const res = await get(`${s.base}/auth/start`);
    const flow = setCookies(res).find((c) => c.startsWith('__Host-dm_flow='))!;
    expect(flow).toMatch(/Secure/);
    expect(flow).toMatch(/Path=\//);
    await s.close();
  });
});

describe('a repeated callback', () => {
  // Chrome on Android sent the same callback twice, under a second apart; the
  // second redemption of the single-use code failed and hid the success.
  it('gives both requests the first session, and redeems the code once', async () => {
    const oidc = stubOidc();
    let exchanges = 0;
    const counting: OidcClient = {
      start: oidc.start,
      exchange: async (code, verifier, nonce) => {
        exchanges++;
        if (exchanges > 1) throw new TokenError('code already used'); // as Cognito answers
        await new Promise((r) => setTimeout(r, 200)); // slow enough for the repeat to overlap
        return oidc.exchange(code, verifier, nonce);
      },
    };
    const s = await serve(loadConfig(AUTH_ENV), counting);
    const flow = cookieValue(await get(`${s.base}/auth/start`), 'dm_flow')!;
    const callback = () => get(`${s.base}/auth/callback?code=good_code&state=${oidc.flow.state}`, `dm_flow=${flow}`);

    const [first, second] = await Promise.all([callback(), callback()]);
    const late = await callback(); // a repeat after the first has finished
    for (const res of [first, second, late]) expect(res.headers.get('location')).toBe('/');
    const tokens = new Set([first, second, late].map((r) => cookieValue(r, 'dm_session')));
    expect(tokens.size).toBe(1);
    expect(exchanges).toBe(1);
    await s.close();
  });

  it('never hands the session to a request without the same flow cookie', async () => {
    const oidc = stubOidc();
    const s = await serve(loadConfig(AUTH_ENV), oidc);
    const flow = cookieValue(await get(`${s.base}/auth/start`), 'dm_flow')!;
    const url = `${s.base}/auth/callback?code=good_code&state=${oidc.flow.state}`;
    expect((await get(url, `dm_flow=${flow}`)).headers.get('location')).toBe('/');
    const stranger = await get(url); // same code and state, no flow cookie
    expect(stranger.headers.get('location')).toBe('/?signin=failed');
    expect(cookieValue(stranger, 'dm_session')).toBeUndefined();
    await s.close();
  });
});

describe('the allowlist', () => {
  // A full sign-in as `identity`; returns the callback response.
  async function signInAs(identity: { subject: string; email: string | null; picture: null; givenName: string | null }, env = AUTH_ENV) {
    const oidc = stubOidc(identity);
    const s = await serve(loadConfig(env), oidc);
    const flow = cookieValue(await get(`${s.base}/auth/start`), 'dm_flow')!;
    const cb = await get(`${s.base}/auth/callback?code=good_code&state=${oidc.flow.state}`, `dm_flow=${flow}`);
    await s.close();
    return cb;
  }
  const userCount = async () => Number((await db.query('select count(*) from users')).rows[0].count);

  it('lets in an email on the list, whatever its case', async () => {
    const cb = await signInAs({ subject: 'sub_friend', email: 'Friend@Gmail.com', picture: null, givenName: null });
    expect(cb.headers.get('location')).toBe('/');
    expect(cookieValue(cb, 'dm_session')).toBeTruthy();
  });

  it('turns away an email not on the list, and creates no user', async () => {
    const cb = await signInAs({ subject: 'sub_stranger', email: 'stranger@gmail.com', picture: null, givenName: null });
    expect(cb.headers.get('location')).toBe('/?signin=not_allowed');
    expect(cookieValue(cb, 'dm_session')).toBeUndefined();
    expect(await userCount()).toBe(0);
  });

  it('turns away a sign-in with no verified email', async () => {
    const cb = await signInAs({ subject: 'sub_unverified', email: null, picture: null, givenName: null });
    expect(cb.headers.get('location')).toBe('/?signin=not_allowed');
    expect(await userCount()).toBe(0);
  });

  it('ends an existing session once its email is taken off the list', async () => {
    const cb = await signInAs({ subject: 'sub_friend', email: 'friend@gmail.com', picture: null, givenName: null });
    const cookie = `dm_session=${cookieValue(cb, 'dm_session')}`;
    const s = await serve(loadConfig({ ...AUTH_ENV, AUTH_ALLOWED_EMAILS: 'me@example.com' }), stubOidc());
    expect(await (await get(`${s.base}/auth/session`, cookie)).json()).toEqual({ signedIn: false });
    expect((await get(`${s.base}/api/me`, cookie)).status).toBe(401);
    await s.close();
  });
});

describe('several addresses (localhost, a dev tunnel)', () => {
  it('returns each sign-in to the address it started on', async () => {
    const { request } = await import('node:http');
    const calls: { start?: string; exchange?: string } = {};
    const oidc = stubOidc();
    const recording: OidcClient = {
      start: (uri?: string) => {
        calls.start = uri;
        return oidc.flow;
      },
      exchange: async (code, verifier, nonce, uri?: string) => {
        calls.exchange = uri;
        return oidc.exchange(code, verifier, nonce);
      },
    };
    const s = await serve(
      loadConfig({ ...AUTH_ENV, AUTH_REDIRECT_URI: 'http://localhost:8100/auth/callback,https://app.dev.example.com/auth/callback' }),
      recording,
    );
    // fetch can't set Host; a raw request can, as nginx forwards it.
    const raw = (path: string, host: string, cookie = '') =>
      new Promise<{ status: number; cookies: string[] }>((resolve, reject) => {
        const u = new URL(s.base);
        request({ host: u.hostname, port: u.port, path, headers: { host, cookie } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, cookies: ([] as string[]).concat(res.headers['set-cookie'] ?? []) });
        })
          .on('error', reject)
          .end();
      });

    const start = await raw('/auth/start', 'app.dev.example.com');
    expect(calls.start).toBe('https://app.dev.example.com/auth/callback');
    const flow = start.cookies.find((c) => c.startsWith('dm_flow='))!.split(';')[0];
    const cb = await raw(`/auth/callback?code=good_code&state=${oidc.flow.state}`, 'app.dev.example.com', flow);
    expect(cb.status).toBe(302);
    expect(calls.exchange).toBe('https://app.dev.example.com/auth/callback');

    // An address not in the list falls back to the first — never to the Host sent.
    await raw('/auth/start', 'evil.example');
    expect(calls.start).toBe('http://localhost:8100/auth/callback');
    await s.close();
  });
});
