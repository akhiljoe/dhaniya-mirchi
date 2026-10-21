// Reading Instamart's auth responses (design Appendix C). The shapes were
// recorded from the real site: HTTP 200 with {statusCode, data:{statusCode,
// statusMessage,...}}; a WAF challenge answers with HTML instead.
import { describe, expect, it } from 'vitest';

import { classifyInstamartAuth, pickAppHeaders } from '../src/worker/adapters/instamart.js';

describe('classifyInstamartAuth', () => {
  it('ok when both status codes are 0', () => {
    expect(classifyInstamartAuth(200, JSON.stringify({ statusCode: 0, data: { statusCode: 0, statusMessage: 'OTP sent' } }))).toBe('ok');
  });

  it('rejected when Instamart answers but refuses', () => {
    expect(classifyInstamartAuth(200, JSON.stringify({ statusCode: 0, data: { statusCode: 1, statusMessage: 'Invalid OTP' } }))).toBe('rejected');
    expect(classifyInstamartAuth(200, JSON.stringify({ statusCode: 400 }))).toBe('rejected');
    expect(classifyInstamartAuth(400, JSON.stringify({ statusCode: 1 }))).toBe('rejected');
  });

  it('unreachable when the answer is not Instamart JSON (a bot challenge page, a 5xx)', () => {
    expect(classifyInstamartAuth(200, '<html>challenge</html>')).toBe('unreachable');
    expect(classifyInstamartAuth(403, '<html>blocked</html>')).toBe('unreachable');
    expect(classifyInstamartAuth(503, '')).toBe('unreachable');
  });
});

describe('pickAppHeaders', () => {
  it('keeps only the app headers Instamart expects, never cookies or auth', () => {
    const picked = pickAppHeaders({
      'x-device-id': 'dev-1',
      'x-build-version': '2.378.0',
      matcher: 'abc',
      cookie: 'secret',
      authorization: 'Bearer x',
      'user-agent': 'ua',
    });
    expect(picked).toEqual({ 'x-device-id': 'dev-1', 'x-build-version': '2.378.0', matcher: 'abc' });
  });
});
