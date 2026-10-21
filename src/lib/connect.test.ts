// The browser side of connecting a grocery app (design §7.10). The page only
// talks to our api; phone and OTP go to it once and are sealed there.
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError, connectErrorText, ensureHousehold, getConnectRequest, startConnect, submitOtp } from './connect';
import { CONNECTABLE_SOURCES } from './constants';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; method: string; body: unknown };
function stub(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const handler = routes[`${call.method} ${call.url}`];
    if (!handler) throw new Error(`unexpected ${call.method} ${call.url}`);
    return handler(call);
  }) as typeof fetch;
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('ensureHousehold', () => {
  it('creates "Home" in the browser timezone when the user has none', async () => {
    const calls = stub({
      'GET /api/me': () => json(200, { userId: 'u', email: null, household: null }),
      'POST /api/households': (c) => json(201, { household: { id: 'h1', name: (c.body as { name: string }).name, timezone: 'x', role: 'owner' } }),
    });
    const h = await ensureHousehold();
    expect(h.id).toBe('h1');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: 'Home', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it('uses the existing household and creates nothing', async () => {
    const calls = stub({
      'GET /api/me': () => json(200, { userId: 'u', email: null, household: { id: 'h9', name: 'Flat', timezone: 'Asia/Kolkata', role: 'owner' } }),
    });
    expect((await ensureHousehold()).id).toBe('h9');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('startConnect / getConnectRequest / submitOtp', () => {
  it('sends the phone as JSON and returns the attempt', async () => {
    const calls = stub({
      'POST /api/connect/instamart': () => json(202, { id: 'r1', vendor: 'instamart', status: 'requested', phoneLast4: '3210', errorCode: null }),
    });
    const r = await startConnect('instamart', '98765 43210');
    expect(r).toMatchObject({ id: 'r1', status: 'requested' });
    expect(calls[0].body).toEqual({ phone: '98765 43210' });
  });

  it('turns an api refusal into an ApiError carrying its message', async () => {
    stub({ 'POST /api/connect/instamart': () => json(409, { error: 'a instamart connection is already in progress' }) });
    await expect(startConnect('instamart', '9876543210')).rejects.toThrow(ApiError);
    await expect(startConnect('instamart', '9876543210')).rejects.toThrow(/already in progress/);
  });

  it('polls status and submits the code', async () => {
    const calls = stub({
      'GET /api/connect/requests/r1': () => json(200, { id: 'r1', status: 'otp_sent', errorCode: null }),
      'POST /api/connect/requests/r1/otp': () => json(202, { id: 'r1', status: 'verifying', errorCode: null }),
    });
    expect((await getConnectRequest('r1')).status).toBe('otp_sent');
    expect((await submitOtp('r1', '4821')).status).toBe('verifying');
    expect(calls[1].body).toEqual({ otp: '4821' });
  });
});

describe('connectErrorText', () => {
  it('has a plain sentence for every error the worker can report', () => {
    for (const code of ['otp_invalid', 'vendor_rejected', 'vendor_unreachable', 'expired', 'interrupted', 'internal']) {
      const text = connectErrorText(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/_/); // never the raw code
    }
  });

  it('falls back to a generic sentence for an unknown code', () => {
    expect(connectErrorText('something_new')).toMatch(/try again/i);
  });
});

describe('CONNECTABLE_SOURCES', () => {
  // Must stay in step with CONNECTABLE_VENDORS in server/src/constants.ts:
  // a vendor listed here with no server adapter offers a connect that fails,
  // and one missing here stays "coming soon" though the server can do it.
  it('lists the apps with a working connect adapter', () => {
    expect(CONNECTABLE_SOURCES).toEqual(['instamart', 'blinkit', 'zepto']);
  });
});
