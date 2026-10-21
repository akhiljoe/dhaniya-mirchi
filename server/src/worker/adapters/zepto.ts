// Zepto connect adapter (design §7.4, §7.10, Appendix D).
//
// The login recorded from the real site on 2026-09-24:
//   header button[aria-label="login"] → phone box → Continue
//     → POST bff-gateway /api/v1/user/customer/send-otp-sms/  {mobileNumber, countryCode}
//   one OTP box (aria-label "OTP"), which submits itself at the sixth digit
//     → POST www.zepto.com /api/auth/verify-otp  → sets accessToken + refreshToken
//
// Unlike Instamart's, this login is driven through the page's own form, not
// our own fetch. Zepto signs every call (`request-signature`), and a login is
// a write: reads were measured to work unsigned, a login never was. The page
// signs its own calls, so the form is the way in that does not depend on the
// signature. What each step answered is read off the wire as the page makes
// it, never off the screen.
import type { Page, Response } from 'playwright-core';

import {
  PAGE_LOAD_TIMEOUT_MS,
  ZEPTO_API_ORIGIN,
  ZEPTO_LOGIN_BUTTON,
  ZEPTO_LOGIN_STEP_TIMEOUT_MS,
  ZEPTO_ORDERS_PATH,
  ZEPTO_ORIGIN,
  ZEPTO_OTP_INPUT,
  ZEPTO_PHONE_INPUT,
  ZEPTO_SEND_OTP_PATH,
  ZEPTO_VERIFY_OTP_PATH,
} from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import { ConnectError, type CapturedSession, type ConnectSession } from '../connect.js';
import { openZeptoPage, readHeaders, sessionCookies } from './zepto-import.js';

// ok: Zepto accepted. rejected: Zepto answered and refused (a wrong code, a
// number it will not serve). unreachable: not a Zepto answer at all - the
// WAF's page, a 5xx, no answer - so trying again later may work.
export function classifyZeptoAuth(status: number, body: string): 'ok' | 'rejected' | 'unreachable' {
  if (status <= 0 || status >= 500 || status === 429) return 'unreachable';
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return 'unreachable';
  }
  if (!json || typeof json !== 'object') return 'unreachable';
  return status >= 200 && status < 300 ? 'ok' : 'rejected';
}

// The answer to the call whose path ends with `path`, as the page makes it.
function answerTo(page: Page, path: string): Promise<Response | null> {
  return page
    .waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path, { timeout: ZEPTO_LOGIN_STEP_TIMEOUT_MS })
    .catch(() => null);
}

async function verdict(res: Response | null): Promise<'ok' | 'rejected' | 'unreachable'> {
  if (!res) return 'unreachable';
  const body = await res.text().catch(() => '');
  return classifyZeptoAuth(res.status(), body);
}

class ZeptoSession implements ConnectSession {
  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
    private readonly appVersion: () => string,
  ) {}

  async requestOtp(phone: string): Promise<void> {
    const { page } = this;
    try {
      await page.locator(ZEPTO_LOGIN_BUTTON).first().click({ timeout: ZEPTO_LOGIN_STEP_TIMEOUT_MS });
      const box = page.locator(ZEPTO_PHONE_INPUT).first();
      await box.fill(phone, { timeout: ZEPTO_LOGIN_STEP_TIMEOUT_MS });
      const sent = answerTo(page, ZEPTO_SEND_OTP_PATH);
      // The form's own Continue, as the household pressed it.
      await box.locator('xpath=ancestor::form[1]//button[@type="submit"]').first().click({ timeout: ZEPTO_LOGIN_STEP_TIMEOUT_MS });
      const v = await verdict(await sent);
      if (v === 'unreachable') throw new ConnectError('vendor_unreachable');
      if (v === 'rejected') throw new ConnectError('vendor_rejected');
    } catch (err) {
      if (err instanceof ConnectError) throw err;
      // The form was not where it was recorded: the page moved, not the user.
      throw new ConnectError('vendor_unreachable');
    }
  }

  async submitOtp(otp: string): Promise<CapturedSession> {
    const { page } = this;
    const box = page.locator(ZEPTO_OTP_INPUT).first();
    let v: 'ok' | 'rejected' | 'unreachable';
    try {
      // Cleared first: after a wrong code the box still holds it.
      await box.fill('', { timeout: ZEPTO_LOGIN_STEP_TIMEOUT_MS });
      const verified = answerTo(page, ZEPTO_VERIFY_OTP_PATH);
      // Typed, not filled: the box submits itself on the last digit, as it
      // did for the household, and only a keystroke tells it one arrived.
      await box.pressSequentially(otp, { timeout: ZEPTO_LOGIN_STEP_TIMEOUT_MS });
      v = await verdict(await verified);
    } catch {
      throw new ConnectError('vendor_unreachable');
    }
    if (v === 'unreachable') throw new ConnectError('vendor_unreachable');
    if (v === 'rejected') throw new ConnectError('otp_invalid');

    // Prove the login reads orders before keeping it: one page of history.
    const check = (await page.evaluate(`(async () => {
      try {
        const r = await fetch(${JSON.stringify(`${ZEPTO_API_ORIGIN}${ZEPTO_ORDERS_PATH}?page_number=1`)}, {
          credentials: 'include', headers: ${JSON.stringify(readHeaders(this.appVersion()))} });
        const j = await r.json();
        return r.status === 200 && Array.isArray(j.orders);
      } catch (e) { return false; }
    })()`)) as boolean;
    if (!check) throw new ConnectError('vendor_rejected');

    const cookies = sessionCookies(
      (await page.context().cookies(ZEPTO_ORIGIN)).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
      })),
    );
    if (!cookies.some((c) => c.name === 'accessToken') || !cookies.some((c) => c.name === 'refreshToken')) {
      throw new ConnectError('vendor_rejected');
    }
    // Nothing from localStorage: the login is in the cookies, and what the
    // site keeps there is the household's cart, addresses and profile.
    return { cookies, localStorage: {} };
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

export function zeptoAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    async open(): Promise<ConnectSession> {
      const hb = await launch();
      try {
        const page = await hb.browser.contexts()[0].newPage();
        page.setDefaultNavigationTimeout(PAGE_LOAD_TIMEOUT_MS);
        let appVersion: () => string;
        try {
          appVersion = await openZeptoPage(page);
        } catch {
          throw new ConnectError('vendor_unreachable');
        }
        return new ZeptoSession(hb, page, appVersion);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}
