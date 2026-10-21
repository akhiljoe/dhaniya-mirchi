// Blinkit connect adapter (design §7.4, §7.10, Appendix A).
//
// The flow recorded from the real site (spike/blinkit/capture-login.ts, run
// 2026-09-20): on blinkit.com,
//   POST /v2/accounts/                  user_phone=<10 digits>        ← sends the SMS
//   POST /v2/accounts/verify/phone/code/ user_phone=…&verify_code=…   ← the login
// Both are form-encoded, not JSON, and both carry the page's own device
// headers (auth_key, device_id, session_uuid, app versions). Those are read
// off the site's own requests rather than invented: they exist before anyone
// logs in, and a made-up one is exactly what the edge looks for.
//
// Two things Blinkit does that Instamart does not:
//   - The page already holds an `access_token` while signed out. A token is
//     therefore no proof of a login; only the verify answer's `success` and
//     `verified`, then a real order_history page, are (Appendix A).
//   - The login state lives in localStorage, not only in cookies. Our fetch
//     bypasses the site's own JS, so nothing writes the new token down for
//     us — the adapter writes it into the page itself before capturing the
//     session, so a restored session is a logged-in page.
import type { Page } from 'playwright-core';

import { BLINKIT_ORIGIN, BLINKIT_SESSION_KEYS, PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS } from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import { ConnectError, type CapturedSession, type ConnectSession } from '../connect.js';
import type { VendorAddress } from './instamart-catalog.js';

// The device and client headers the page attaches to its own API calls. Every
// one of them is read from the live page; none is a constant here, because
// the versions move with the deployed site and `auth_key` / `device_id` /
// `session_uuid` belong to that browser profile (Appendix A).
const APP_HEADERS = [
  'app_client',
  'app_version',
  'auth_key',
  'device_id',
  'session_uuid',
  'platform',
  'lat',
  'lon',
  'web_app_version',
  'rn_bundle_version',
  'x-age-consent-granted',
];

export function pickAppHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of APP_HEADERS) if (headers[name]) out[name] = headers[name];
  return out;
}

// `app_version` differs per service (52434332 on /v2/accounts, 1010101011 on
// /v1/layout — Appendix A), so the bags are kept apart and a call uses the one
// its own family sent, falling back to the other when the page has not made
// that kind of call yet.
export type HeaderBags = { v1: Record<string, string>; v2: Record<string, string> };

export function bagFor(bags: HeaderBags, path: string): Record<string, string> {
  const family = path.startsWith('/v1/') ? 'v1' : 'v2';
  const own = bags[family];
  if (Object.keys(own).length) return own;
  return family === 'v1' ? bags.v2 : bags.v1;
}

// ok: Blinkit accepted. rejected: Blinkit answered and refused (wrong code,
// number it won't serve). unreachable: not a Blinkit answer at all — the edge's
// HTML block page, a 5xx — so trying again later may work.
export function classifyBlinkitAuth(status: number, body: string): 'ok' | 'rejected' | 'unreachable' {
  if (status >= 500) return 'unreachable';
  let json: { success?: unknown } | null = null;
  try {
    json = JSON.parse(body) as { success?: unknown };
  } catch {
    // A block page is HTML, and so is a gateway error: neither is a refusal.
    return 'unreachable';
  }
  if (!json || typeof json !== 'object') return 'unreachable';
  if (status !== 200) return 'rejected';
  return json.success === true ? 'ok' : 'rejected';
}

// The send-OTP answer, read strictly. Blinkit says what it is doing:
// `action: "login"` for an account that exists (Appendix A). A number with no
// Blinkit account would be a sign-up, and connecting an app must never create
// an account - the household would be sent a code for an account it does not
// have. `sms_sent: false` is refused for the same reason: no code is coming,
// so waiting for one only wastes the attempt. Anything else Blinkit calls the
// action is let through: only a sign-up is refused, never an unfamiliar word.
export function readSendOtp(body: string): 'sent' | 'no_account' | 'not_sent' {
  try {
    const json = JSON.parse(body) as { action?: unknown; sms_sent?: unknown };
    if (typeof json.action === 'string' && /sign.?up|register|create/i.test(json.action)) return 'no_account';
    if (json.sms_sent === false) return 'not_sent';
    return 'sent';
  } catch {
    return 'not_sent';
  }
}

// The verify answer, read strictly: a token alone means nothing here.
export function readVerifiedToken(body: string): string | null {
  try {
    const json = JSON.parse(body) as { success?: unknown; verified?: unknown; access_token?: unknown };
    if (json.success !== true || json.verified !== true) return null;
    return typeof json.access_token === 'string' && json.access_token.length > 0 ? json.access_token : null;
  } catch {
    return null;
  }
}

// Who the vendor says just logged in.
//
// The verify answer carries a `user` block, and the site's own JavaScript
// copies it into `localStorage.user` in camelCase. Our fetch is not that
// JavaScript, so nothing copied it, and `user` stayed
// `{"properties":{},"profile":{}}` - which reads to the vendor's own checkout
// as nobody being signed in. Every API call still worked, so this went
// unnoticed until a payment was tried: the cart page offers "Login to
// Proceed" and the CVV box lives behind it (design Appendix A).
//
// Measured by logging in for real and diffing the browser: four fields
// appear, and these are they.
export interface BlinkitUser {
  dateNow: number | null;
  id: number | null;
  phone: string;
  verified: boolean;
}

export function readVerifiedUser(body: string): BlinkitUser | null {
  try {
    const json = JSON.parse(body) as { user?: Record<string, unknown>; verified?: unknown };
    const u = json.user;
    if (!u || typeof u !== 'object') return null;
    // `verified` is the field the checkout cares about. A login that did not
    // verify is not one to write down.
    const verified = u.verified === true || json.verified === true;
    if (!verified) return null;
    const id = typeof u.id === 'number' ? u.id : Number(u.id);
    return {
      dateNow: typeof u.date_now === 'number' ? u.date_now : null,
      id: Number.isFinite(id) ? id : null,
      phone: typeof u.phone === 'string' ? u.phone : String(u.phone ?? ''),
      verified: true,
    };
  } catch {
    return null;
  }
}

// What we keep of the page's storage: the keys that make the session a
// session, and nothing else. The page also holds the household's searches,
// its recommendations and its live cart; none of that is ours to seal away.
export function sessionStorage(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BLINKIT_SESSION_KEYS) if (all[key] !== undefined) out[key] = all[key];
  return out;
}

// Blinkit's saved addresses, as `GET /v4/address` returns them and as the
// page caches them in `localStorage.addressesV2`.
//
// The shape here is the vendor's own, read off a live call (2026-09-22), not
// guessed: `label` ("Home"), `line1`/`line2`, `location_info.postal_code`,
// `display_address`, and `latitude`/`longitude` - with a second, corrected
// pair the vendor prefers when it says so. The first version of this read
// `address_label`, `tag`, `address_line1` and `city`, none of which exist, so
// every address came back with no label and no display text.
//
// Takes either the whole cache slice or the bare response. An empty list is
// normal (a household that has never saved one) and must never fail a
// connect.
export function readStoredAddresses(raw: string | undefined): VendorAddress[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const d = data as { addresses?: { addresses_data?: unknown } | unknown; addresses_data?: unknown };
  const rows = (d?.addresses as { addresses_data?: unknown })?.addresses_data ?? d?.addresses_data ?? d?.addresses;
  if (!Array.isArray(rows)) return [];
  const out: VendorAddress[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const id = o.id ?? o.address_id;
    // The vendor carries a corrected pair beside the saved one and says which
    // to use. Honouring that is the difference between the household's door
    // and a pin dropped near it - and on Blinkit the coordinates choose the
    // store, so it is also the difference between the right shop and one a
    // city away.
    const corrected = o.corrected_location_info as { latitude?: unknown; longitude?: unknown } | undefined;
    const useCorrected = o.use_corrected_location === true && corrected !== undefined;
    const lat = Number(useCorrected ? corrected?.latitude : (o.latitude ?? o.lat));
    const lng = Number(useCorrected ? corrected?.longitude : (o.longitude ?? o.lon ?? o.lng));
    if (id === undefined || id === null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const place = o.location_info as { postal_code?: unknown; city?: unknown; state?: unknown } | undefined;
    const parts = [o.line1, o.line2, o.landmark, place?.city, place?.postal_code]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());
    // Counted on this household's account: 12 ZOMATO_IMPORT, 9 ZOMATO, 2
    // SHARED_ADDRESS and 16 with none at all.
    const meta = o.address_meta as { source?: unknown } | undefined;
    out.push({
      id: String(id),
      label: typeof o.label === 'string' ? o.label : typeof o.address_label === 'string' ? o.address_label : '',
      display: parts.length ? parts.join(', ') : typeof o.display_address === 'string' ? o.display_address : '',
      lat,
      lng,
      name: typeof o.name === 'string' ? o.name : '',
      ...(typeof meta?.source === 'string' && meta.source ? { source: meta.source } : {}),
    });
  }
  return out;
}

async function inPageForm(page: Page, path: string, fields: Record<string, string>, headers: Record<string, string>) {
  const args = JSON.stringify({
    path,
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, { method: 'POST', credentials: 'include', headers: a.headers, body: a.body });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

async function inPageJson(page: Page, path: string, body: unknown, headers: Record<string, string>) {
  const args = JSON.stringify({ path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, { method: 'POST', credentials: 'include', headers: a.headers, body: a.body });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

class BlinkitSession implements ConnectSession {
  // Held only between send-OTP and verify: Blinkit's verify call resends the
  // number, unlike Instamart's. It never leaves this object.
  private phone: string | null = null;

  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
    private readonly bags: () => HeaderBags,
  ) {}

  private headers(path: string): Record<string, string> {
    return bagFor(this.bags(), path);
  }

  async requestOtp(phone: string): Promise<void> {
    this.phone = phone;
    const path = '/v2/accounts/';
    const r = await inPageForm(this.page, path, { user_phone: phone }, this.headers(path));
    const verdict = classifyBlinkitAuth(r.status, r.body);
    if (verdict === 'unreachable') throw new ConnectError('vendor_unreachable');
    if (verdict === 'rejected') throw new ConnectError('vendor_rejected');
    if (readSendOtp(r.body) !== 'sent') throw new ConnectError('vendor_rejected');
  }

  async submitOtp(otp: string): Promise<CapturedSession> {
    if (!this.phone) throw new ConnectError('internal');
    const path = '/v2/accounts/verify/phone/code/';
    const r = await inPageForm(this.page, path, { user_phone: this.phone, verify_code: otp }, this.headers(path));
    const verdict = classifyBlinkitAuth(r.status, r.body);
    if (verdict === 'unreachable') throw new ConnectError('vendor_unreachable');
    if (verdict === 'rejected') throw new ConnectError('otp_invalid');
    const token = readVerifiedToken(r.body);
    if (!token) throw new ConnectError('otp_invalid');

    // Our fetch is not the site's own code, so nothing has written the new
    // token down. Put it where the app keeps it, so the restored session is a
    // logged-in page rather than a page holding the anonymous token.
    //
    // The token alone is not enough, and this is the difference between a
    // session that can read and one that can pay. The site also writes WHO
    // signed in, into `localStorage.user`, and its own checkout reads that
    // rather than the token: without it the cart page offers "Login to
    // Proceed" and the CVV box behind it cannot be reached, while every API
    // call carries on working. That is why it went unnoticed until a payment
    // was tried (design Appendix A).
    //
    // Proved by capturing a real page login and restoring it the way the
    // worker does, into a clean browser profile, with only the eight keys
    // kept here: the vendor's own cart page then says "Proceed To Pay". The
    // one thing that session had and a connected one did not was a populated
    // `user`.
    //
    // It must be written BEFORE the page's own scripts run, which is what a
    // restore does (`addInitScript`) and what this does, here, before the
    // session is captured. Written after the page has booted it is discarded:
    // the app persists its own in-memory state back over it, which is what
    // made an earlier attempt at this look impossible.
    const who = readVerifiedUser(r.body);
    await this.page.evaluate(`(() => {
      const t = ${JSON.stringify(token)};
      const phone = ${JSON.stringify(this.phone)};
      const who = ${JSON.stringify(who)};
      try {
        const auth = JSON.parse(localStorage.getItem('auth') || '{}') || {};
        auth.accessToken = t;
        auth.phoneNumber = phone;
        localStorage.setItem('auth', JSON.stringify(auth));
      } catch { localStorage.setItem('auth', JSON.stringify({ accessToken: t, phoneNumber: phone })); }
      if (who) {
        let user = { properties: {}, profile: {} };
        try { user = JSON.parse(localStorage.getItem('user') || '') || user; } catch (e) { /* first login */ }
        user.dateNow = who.dateNow;
        user.id = who.id;
        user.phone = who.phone;
        user.verified = who.verified;
        localStorage.setItem('user', JSON.stringify(user));
      }
      document.cookie = 'gr_1_accessToken=' + t + '; path=/; secure';
    })()`);

    // Prove the login before keeping it: one page of real orders.
    const ordersPath = '/v1/layout/order_history';
    const check = await inPageJson(this.page, ordersPath, { offset: 0, limit: 1 }, { ...this.headers(ordersPath), access_token: token });
    if (check.status !== 200) throw new ConnectError(check.status >= 500 ? 'vendor_unreachable' : 'vendor_rejected');
    try {
      const parsed = JSON.parse(check.body) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    } catch {
      throw new ConnectError('vendor_rejected');
    }

    const cookies = (await this.page.context().cookies(BLINKIT_ORIGIN)).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
    }));
    const all = (await this.page.evaluate(
      `Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))`,
    )) as Record<string, string>;
    return { cookies, localStorage: sessionStorage(all) };
  }

  // The home page is loaded first, and then the cache is read.
  //
  // `localStorage.addressesV2` is the page's own query slice, and a session
  // captured during the login flow holds it at `status: "idle"` - never
  // fetched. Reading it then returns nothing, which looked like "this
  // household has saved no addresses" and left the coordinates at the
  // vendor's default city, a thousand kilometres from the household. On
  // Blinkit the coordinates choose the store, so that is not a cosmetic
  // mistake: it is the wrong shop and the wrong catalogue.
  //
  // The home page fetches the addresses itself (`GET /v4/address`, which
  // carries an `access_token` and the lat/lon that the /v1 calls do not), so
  // loading it and waiting is enough - no call of ours, no headers invented.
  // It is also the one page measured to make no cart writes, which is why the
  // import uses it too (design Appendix A).
  async addresses(): Promise<VendorAddress[]> {
    try {
      if (!this.page.url().startsWith(BLINKIT_ORIGIN)) {
        await this.page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
      }
      await this.page.waitForTimeout(PAGE_SETTLE_MS);
      const raw = (await this.page.evaluate(`localStorage.getItem('addressesV2')`)) as string | null;
      return readStoredAddresses(raw ?? undefined);
    } catch {
      // An empty list is normal and must never fail a connect (§19 stage 1).
      return [];
    }
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

export function blinkitAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    async open(): Promise<ConnectSession> {
      const hb = await launch();
      try {
        const page = await hb.browser.contexts()[0].newPage();
        const bags: HeaderBags = { v1: {}, v2: {} };
        page.on('request', (req) => {
          const url = req.url();
          if (!url.startsWith(BLINKIT_ORIGIN)) return;
          const path = url.slice(BLINKIT_ORIGIN.length);
          const family = path.startsWith('/v1/') ? 'v1' : path.startsWith('/v2/') ? 'v2' : null;
          if (!family) return;
          const picked = pickAppHeaders(req.headers());
          // auth_key and device_id are what make the bag worth keeping; a call
          // made before the page has them would poison it.
          if (picked.auth_key && picked.device_id) bags[family] = picked;
        });
        const res = await page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        if (!res || res.status() !== 200) throw new ConnectError('vendor_unreachable');
        await page.waitForTimeout(PAGE_SETTLE_MS);
        if (!Object.keys(bags.v1).length && !Object.keys(bags.v2).length) throw new ConnectError('vendor_unreachable');
        return new BlinkitSession(hb, page, () => bags);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}
