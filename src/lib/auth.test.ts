// The browser side of sign-in (design §14.3): the SPA never sees a Cognito
// token — it only asks the api whether this browser has a session.
import { afterEach, describe, expect, it } from 'vitest';

import {
  fetchSession,
  googleSignInWorksHere,
  PICTURE_URL,
  pictureUrlFor,
  signInOutcome,
  signOut,
  SIGN_IN_URL,
} from './auth';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

describe('fetchSession', () => {
  it('reports a signed-in user', async () => {
    stub(() => new Response(JSON.stringify({ signedIn: true, userId: 'sub_1' }), { status: 200 }));
    expect(await fetchSession()).toEqual({ state: 'signed-in', userId: 'sub_1' });
  });

  it('reports signed-out', async () => {
    stub(() => new Response(JSON.stringify({ signedIn: false }), { status: 200 }));
    expect(await fetchSession()).toEqual({ state: 'signed-out' });
  });

  it('reports sign-in as unavailable when the server has it switched off (503)', async () => {
    stub(() => new Response(JSON.stringify({ error: 'sign-in is not configured' }), { status: 503 }));
    expect(await fetchSession()).toEqual({ state: 'unavailable' });
  });

  it('reports unavailable, not signed-out, when the server cannot be reached', async () => {
    stub(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchSession()).toEqual({ state: 'unavailable' });
  });

  it('asks the same-origin api, never caching the answer', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    stub((url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ signedIn: false }), { status: 200 });
    });
    await fetchSession();
    expect(seen!.url).toBe('/auth/session');
    expect(seen!.init?.credentials).toBe('same-origin');
    expect(seen!.init?.cache).toBe('no-store');
  });
});

describe('signOut', () => {
  it('POSTs to the api', async () => {
    let method = '';
    let url = '';
    stub((u, init) => {
      url = u;
      method = init?.method ?? 'GET';
      return new Response(null, { status: 204 });
    });
    await signOut();
    expect(url).toBe('/auth/signout');
    expect(method).toBe('POST');
  });
});

describe('pictureUrlFor', () => {
  it('gives each user their own picture address, so a cached photo never crosses accounts', () => {
    const a = pictureUrlFor({ userId: 'user-a' });
    const b = pictureUrlFor({ userId: 'user-b' });
    expect(a.startsWith(PICTURE_URL)).toBe(true);
    expect(a).not.toBe(b);
    expect(pictureUrlFor({ userId: 'user-a' })).toBe(a);
  });
});

describe('signInOutcome', () => {
  it('reads the result the api appends after a failed or cancelled sign-in', () => {
    expect(signInOutcome('?signin=failed')).toBe('failed');
    expect(signInOutcome('?signin=cancelled')).toBe('cancelled');
    expect(signInOutcome('?signin=not_allowed')).toBe('not_allowed');
  });

  it('ignores anything else', () => {
    expect(signInOutcome('')).toBeNull();
    expect(signInOutcome('?signin=hacked')).toBeNull();
    expect(signInOutcome('?other=1')).toBeNull();
  });
});

describe('SIGN_IN_URL', () => {
  it('is the api route that starts the Google flow — a full-page navigation, not fetch', () => {
    expect(SIGN_IN_URL).toBe('/auth/start');
  });
});

describe('fetchMe', () => {
  it('returns who is signed in, whether they have a photo, and their household', async () => {
    const { fetchMe } = await import('./auth');
    stub(() =>
      new Response(JSON.stringify({ userId: 'u1', email: 'a@example.com', hasPicture: true, household: { id: 'h1', name: 'Home', timezone: 'Asia/Kolkata', role: 'owner' } }), { status: 200 }),
    );
    expect(await fetchMe()).toEqual({
      userId: 'u1',
      email: 'a@example.com',
      hasPicture: true,
      household: { id: 'h1', name: 'Home', timezone: 'Asia/Kolkata', role: 'owner' },
    });
  });

  it('is null when not signed in or the server cannot be reached', async () => {
    const { fetchMe } = await import('./auth');
    stub(() => new Response(JSON.stringify({ error: 'sign in first' }), { status: 401 }));
    expect(await fetchMe()).toBeNull();
    stub(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchMe()).toBeNull();
  });
});

describe('initialOf', () => {
  it('is the first letter of the email, upper-cased, for the no-photo circle', async () => {
    const { initialOf } = await import('./auth');
    expect(initialOf('akhil@example.com')).toBe('A');
    expect(initialOf(null)).toBe('?');
    expect(initialOf('')).toBe('?');
  });
});

describe('googleSignInWorksHere', () => {
  it('is true on https and on localhost — Cognito allows plain http only there', () => {
    expect(googleSignInWorksHere({ protocol: 'https:', hostname: 'app.example.com' })).toBe(true);
    expect(googleSignInWorksHere({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
  });

  it('is false on a plain-http home network address', () => {
    expect(googleSignInWorksHere({ protocol: 'http:', hostname: '192.168.0.106' })).toBe(false);
  });
});

