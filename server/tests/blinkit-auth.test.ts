// Reading Blinkit's auth responses (design Appendix A). The shapes were
// recorded from the real login on 2026-09-20: HTTP 200 with {success, ...},
// the verify call answering {access_token, success, verified, user}. The edge's
// bot block answers with HTML instead, which is not a refusal.
import { describe, expect, it } from 'vitest';

import { bagFor, classifyBlinkitAuth, pickAppHeaders, readSendOtp, readStoredAddresses, readVerifiedToken, readVerifiedUser, sessionStorage } from '../src/worker/adapters/blinkit.js';

describe('classifyBlinkitAuth', () => {
  it('ok when Blinkit says success', () => {
    const sent = JSON.stringify({ login: true, action: 'login', sms_sent: true, message_id: 'm-1', success: true, message: 'We have sent a verification code to you via SMS' });
    expect(classifyBlinkitAuth(200, sent)).toBe('ok');
  });

  it('rejected when Blinkit answers and refuses', () => {
    expect(classifyBlinkitAuth(200, JSON.stringify({ success: false, message: 'Invalid code' }))).toBe('rejected');
    expect(classifyBlinkitAuth(400, JSON.stringify({ success: false }))).toBe('rejected');
    expect(classifyBlinkitAuth(401, JSON.stringify({ message: 'unauthorized' }))).toBe('rejected');
  });

  it('unreachable when the answer is not Blinkit JSON (the edge block page, a 5xx)', () => {
    expect(classifyBlinkitAuth(403, '<html>Access denied</html>')).toBe('unreachable');
    expect(classifyBlinkitAuth(200, '<html>challenge</html>')).toBe('unreachable');
    expect(classifyBlinkitAuth(503, '')).toBe('unreachable');
    expect(classifyBlinkitAuth(500, JSON.stringify({ success: false }))).toBe('unreachable');
  });
});

describe('readVerifiedToken', () => {
  it('takes the token only when the login actually succeeded', () => {
    const body = JSON.stringify({
      access_token: 'tok-abcdef',
      message: 'Login Successful',
      success: true,
      verified: true,
      user: { id: 1, phone: '9000000000', verified: true, country_code: '91' },
    });
    expect(readVerifiedToken(body)).toBe('tok-abcdef');
  });

  // Appendix A: the page holds an anonymous access_token while signed out, so
  // a token in an answer is no proof of a login.
  it('refuses a token when success or verified is missing', () => {
    expect(readVerifiedToken(JSON.stringify({ access_token: 'tok', success: true }))).toBeNull();
    expect(readVerifiedToken(JSON.stringify({ access_token: 'tok', verified: true }))).toBeNull();
    expect(readVerifiedToken(JSON.stringify({ access_token: 'tok', success: false, verified: false, message: 'Invalid code' }))).toBeNull();
    expect(readVerifiedToken(JSON.stringify({ success: true, verified: true }))).toBeNull();
    expect(readVerifiedToken('<html>blocked</html>')).toBeNull();
  });
});

describe('pickAppHeaders', () => {
  it('keeps the device and client headers the page sends, never cookies or the token', () => {
    const picked = pickAppHeaders({
      app_client: 'consumer_web',
      app_version: '52434332',
      auth_key: 'k'.repeat(64),
      device_id: 'd'.repeat(16),
      session_uuid: '00000000-0000-4000-8000-000000000000',
      platform: 'desktop_web',
      lat: '12.97',
      lon: '77.59',
      web_app_version: '1008010016',
      rn_bundle_version: '1009003012',
      access_token: 'anonymous-token',
      cookie: 'secret',
      'user-agent': 'ua',
    });
    expect(picked.access_token).toBeUndefined();
    expect(picked.cookie).toBeUndefined();
    expect(picked['user-agent']).toBeUndefined();
    expect(picked.auth_key).toBe('k'.repeat(64));
    expect(picked.app_version).toBe('52434332');
    expect(picked.platform).toBe('desktop_web');
  });
});

describe('bagFor', () => {
  // app_version differs per service: 52434332 on /v2/accounts, 1010101011 on
  // /v1/layout (Appendix A). Sending one service's version to the other is the
  // mistake this exists to prevent.
  const bags = { v1: { app_version: '1010101011' }, v2: { app_version: '52434332' } };

  it('uses each service its own headers', () => {
    expect(bagFor(bags, '/v1/layout/order_history').app_version).toBe('1010101011');
    expect(bagFor(bags, '/v2/accounts/').app_version).toBe('52434332');
  });

  it('falls back to the other family when one has not been seen', () => {
    expect(bagFor({ v1: {}, v2: { app_version: '52434332' } }, '/v1/layout/order_history').app_version).toBe('52434332');
    expect(bagFor({ v1: { app_version: '1010101011' }, v2: {} }, '/v2/accounts/').app_version).toBe('1010101011');
  });
});

// The shape here is the vendor's own, read off a live `GET /v4/address`
// (2026-09-22) - the values are invented, the field names are not. The first
// version of this parser was written against guessed names (`address_label`,
// `building`, `city`, `address_line1`), none of which Blinkit sends, so every
// address came back with an empty label and empty display text.
describe('readStoredAddresses', () => {
  const home = {
    id: 100000001,
    label: 'Home',
    label_id: 'HOME',
    name: 'A Household',
    line1: 'House No.2, 2nd Floor, Some Building',
    line2: 'Some Locality, Bengaluru',
    landmark: null,
    latitude: 12.971600,
    longitude: 77.594600,
    location_info: { state: 'Karnataka', postal_code: '560002', city: '' },
    display_address: 'House No.2, 2nd Floor, Some Building, Some Locality',
    use_corrected_location: false,
    corrected_location_info: { confidence: 'CX_ADD_ADDRESS_VERIFICATION', latitude: 12.9, longitude: 77.7 },
  };

  it('reads the label, the coordinates and a readable line', () => {
    const raw = JSON.stringify({ addresses: { message: 'Addresses fetched', addresses_data: [home] }, error: null, status: 'fulfilled' });
    expect(readStoredAddresses(raw)).toEqual([
      {
        id: '100000001',
        label: 'Home',
        display: 'House No.2, 2nd Floor, Some Building, Some Locality, Bengaluru, 560002',
        lat: 12.971600,
        lng: 77.594600,
        name: 'A Household',
      },
    ]);
  });

  // On Blinkit the coordinates choose the store, so the pair the vendor says
  // to use is the difference between the household's shop and one a city away.
  it('uses the corrected coordinates when the vendor says to', () => {
    const raw = JSON.stringify({ addresses: { addresses_data: [{ ...home, use_corrected_location: true }] } });
    expect(readStoredAddresses(raw)[0]).toMatchObject({ lat: 12.9, lng: 77.7 });
  });

  it('takes the bare response as well as the page s cache slice', () => {
    expect(readStoredAddresses(JSON.stringify({ addresses_data: [home] }))).toHaveLength(1);
    expect(readStoredAddresses(JSON.stringify({ addresses: [home] }))).toHaveLength(1);
  });

  it('falls back to the display line when there are no parts to join', () => {
    const bare = { id: 7, label: 'Work', latitude: 12.9, longitude: 77.6, display_address: 'An office, somewhere' };
    expect(readStoredAddresses(JSON.stringify({ addresses: { addresses_data: [bare] } }))[0]).toMatchObject({
      display: 'An office, somewhere',
    });
  });

  // A household that has never saved one. Connecting must not fail over it.
  it('gives an empty list rather than failing on empty, missing or broken storage', () => {
    expect(readStoredAddresses(JSON.stringify({ addresses: { addresses_data: [] } }))).toEqual([]);
    expect(readStoredAddresses(JSON.stringify({ addresses: {} }))).toEqual([]);
    expect(readStoredAddresses('not json')).toEqual([]);
    expect(readStoredAddresses(undefined)).toEqual([]);
  });

  it('drops an address with no usable coordinates', () => {
    const raw = JSON.stringify({ addresses: { addresses_data: [{ id: 9, label: 'X', latitude: 'x', longitude: null }] } });
    expect(readStoredAddresses(raw)).toEqual([]);
  });
});

describe('readSendOtp', () => {
  it('accepts the answer a real login gets', () => {
    const sent = JSON.stringify({ login: true, action: 'login', sms_sent: true, success: true });
    expect(readSendOtp(sent)).toBe('sent');
  });

  // Connecting an app must never create an account at the vendor.
  it('refuses a number Blinkit would sign up rather than log in', () => {
    expect(readSendOtp(JSON.stringify({ action: 'signup', sms_sent: true, success: true }))).toBe('no_account');
    expect(readSendOtp(JSON.stringify({ action: 'sign_up', sms_sent: true, success: true }))).toBe('no_account');
    expect(readSendOtp(JSON.stringify({ action: 'register', success: true }))).toBe('no_account');
  });

  it('refuses when no code was sent, rather than leaving someone waiting for it', () => {
    expect(readSendOtp(JSON.stringify({ action: 'login', sms_sent: false, success: true }))).toBe('not_sent');
    expect(readSendOtp('<html>blocked</html>')).toBe('not_sent');
  });

  // An unfamiliar word is not a sign-up: only a sign-up is refused.
  it('lets an action it does not recognise through', () => {
    expect(readSendOtp(JSON.stringify({ action: 'otp_resend', sms_sent: true }))).toBe('sent');
    expect(readSendOtp(JSON.stringify({ sms_sent: true }))).toBe('sent');
  });
});

describe('sessionStorage', () => {
  // Blinkit's page holds 22 keys; sealing all of them stored 201 KB per
  // connection, the household's searches and live cart among them. The eight
  // that matter seal 3 KB and read orders identically (checked live).
  it('keeps what makes the session, and nothing else', () => {
    const kept = sessionStorage({
      auth: '{"accessToken":"t","phoneNumber":"9000000000"}',
      authKey: 'k',
      deviceId: 'd',
      user: '{"id":1}',
      merchant: '{"id":2}',
      location: '{"coords":{}}',
      searchHistory: '["paneer","milk"]',
      recommendations: '[...]',
      cart: '{"items":[]}',
      checkout: '{"card":"tok"}',
      analyticsConfig: '{}',
    });
    expect(Object.keys(kept).sort()).toEqual(['auth', 'authKey', 'deviceId', 'location', 'merchant', 'user']);
    expect(kept.searchHistory).toBeUndefined();
    expect(kept.cart).toBeUndefined();
    expect(kept.checkout).toBeUndefined();
  });

  it('does not invent a key the page never had', () => {
    expect(sessionStorage({ auth: 'a' })).toEqual({ auth: 'a' });
    expect(sessionStorage({})).toEqual({});
  });
});

describe('who the vendor says just logged in', () => {
  // The real verify answer, field for field (login recon 2026-09-20).
  const body = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
    JSON.stringify({
      access_token: 'TOKEN',
      message: 'Login Successful',
      success: true,
      verified: true,
      user: { date_now: 1789907539, id: 10000001, phone: '9123454567', verified: true, country_code: 91, is_international: false, ...over },
      ...top,
    });

  it('takes the four fields the site writes down', () => {
    // Measured by logging in for real and diffing the browser: localStorage
    // `user` gains exactly dateNow, id, phone and verified.
    expect(readVerifiedUser(body())).toEqual({ dateNow: 1789907539, id: 10000001, phone: '9123454567', verified: true });
  });

  it('refuses a login that did not verify', () => {
    // The vendor's own checkout reads `verified`. A login that is not one is
    // not something to write down as one.
    expect(readVerifiedUser(body({ verified: false }, { verified: false }))).toBeNull();
  });

  it('accepts the top-level verified when the user block omits it', () => {
    expect(readVerifiedUser(body({ verified: undefined }))?.verified).toBe(true);
  });

  it('says nothing rather than half a user', () => {
    expect(readVerifiedUser('not json')).toBeNull();
    expect(readVerifiedUser(JSON.stringify({ success: true, verified: true }))).toBeNull();
  });

  it('carries no token, because this is not where a token belongs', () => {
    expect(JSON.stringify(readVerifiedUser(body()))).not.toContain('TOKEN');
  });
});
