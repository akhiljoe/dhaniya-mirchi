// Instamart connect adapter (design §7.4, §7.10, Appendix C).
//
// The flow recorded from the real site (spike/instamart): on instamart.in,
//   POST /api/instamart/auth/signin-check  {data:{mobile}}
//   POST /api/instamart/auth/send-otp      {data:{mobile}}
//   POST /api/instamart/auth/verify-otp    {data:{otp}}      ← no mobile: the login
//                                                           state is in the cookies
// All calls are `fetch` from inside the loaded page (the page's own origin,
// cookies and fingerprint), carrying the app's own headers, which are read off
// the site's first API request rather than invented.
import type { Page } from 'playwright-core';

import { INSTAMART_ORIGIN, PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS } from '../../constants.js';
import { readAddresses, readCustomerId, type VendorAddress } from './instamart-catalog.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import { ConnectError, type CapturedSession, type ConnectSession } from '../connect.js';

const APP_HEADERS = ['x-device-id', 'x-build-version', 'matcher'];

export function pickAppHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of APP_HEADERS) if (headers[name]) out[name] = headers[name];
  return out;
}

// ok: Instamart accepted. rejected: Instamart answered and refused (wrong OTP,
// number not allowed). unreachable: not an Instamart answer at all — a bot
// challenge page, a 5xx — so retrying later may work.
export function classifyInstamartAuth(status: number, body: string): 'ok' | 'rejected' | 'unreachable' {
  let json: { statusCode?: unknown; data?: { statusCode?: unknown } } | null = null;
  try {
    json = JSON.parse(body);
  } catch {
    return 'unreachable';
  }
  if (status >= 500 || !json || typeof json !== 'object') return 'unreachable';
  if (status !== 200) return 'rejected';
  const outer = json.statusCode;
  const inner = json.data?.statusCode;
  return outer === 0 && (inner === undefined || inner === 0) ? 'ok' : 'rejected';
}

async function inPagePost(page: Page, path: string, body: unknown, headers: Record<string, string>) {
  const args = JSON.stringify({ path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, { method: 'POST', credentials: 'include', headers: a.headers, body: a.body });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

async function inPageGet(page: Page, path: string) {
  return page.evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(path)}, { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

class InstamartSession implements ConnectSession {
  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
    private readonly appHeaders: () => Record<string, string>,
  ) {}

  private async call(path: string, body: unknown, onRejected: ConnectError) {
    const r = await inPagePost(this.page, path, body, this.appHeaders());
    const verdict = classifyInstamartAuth(r.status, r.body);
    if (verdict === 'unreachable') throw new ConnectError('vendor_unreachable');
    if (verdict === 'rejected') throw onRejected;
  }

  async requestOtp(phone: string): Promise<void> {
    await this.call('/api/instamart/auth/signin-check', { data: { mobile: phone } }, new ConnectError('vendor_rejected'));
    await this.call('/api/instamart/auth/send-otp', { data: { mobile: phone } }, new ConnectError('vendor_rejected'));
  }

  async submitOtp(otp: string): Promise<CapturedSession> {
    await this.call('/api/instamart/auth/verify-otp', { data: { otp } }, new ConnectError('otp_invalid'));
    // Prove the login works before keeping it: one page of orders.
    const check = await inPageGet(this.page, `/api/instamart/orders?order_type=DASH&count=1&from_time=${Date.now()}`);
    let ok = false;
    try {
      ok = check.status === 200 && Array.isArray(JSON.parse(check.body).data?.orders);
    } catch {
      ok = false;
    }
    if (!ok) throw new ConnectError('vendor_rejected');

    const cookies = (await this.page.context().cookies(INSTAMART_ORIGIN)).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
    }));
    const localStorage = (await this.page.evaluate(
      `Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))`,
    )) as Record<string, string>;
    return { cookies, localStorage };
  }

  // The addresses the household has saved in the app, so it can say which
  // one its groceries come to (design §19 stage 1): the store, and so which
  // cart the app shows, follows from it.
  async addresses(): Promise<VendorAddress[]> {
    // Asked for by account ("customerId"), which the order list carries.
    const orders = await inPageGet(this.page, `/api/instamart/orders?order_type=DASH&count=1&from_time=${Date.now()}`);
    let customer: string | null = null;
    try {
      customer = readCustomerId(JSON.parse(orders.body));
    } catch {
      customer = null;
    }
    const r = await inPageGet(this.page, `/api/instamart/maps/getUserAddresses${customer ? `?customerId=${encodeURIComponent(customer)}` : ''}`);
    if (r.status !== 200) return [];
    try {
      return readAddresses(JSON.parse(r.body));
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

export function instamartAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    async open(): Promise<ConnectSession> {
      const hb = await launch();
      try {
        const page = await hb.browser.contexts()[0].newPage();
        let headers: Record<string, string> = {};
        page.on('request', (req) => {
          if (Object.keys(headers).length === 0 && req.url().includes('/api/instamart/')) {
            const picked = pickAppHeaders(req.headers());
            if (Object.keys(picked).length) headers = picked;
          }
        });
        const res = await page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        if (!res || res.status() !== 200) throw new ConnectError('vendor_unreachable');
        await page.waitForTimeout(PAGE_SETTLE_MS);
        return new InstamartSession(hb, page, () => headers);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}
