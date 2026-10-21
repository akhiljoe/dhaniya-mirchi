// Zepto import adapter (design §7.10, Appendix D).
//
//   list:   GET  bff-gateway /api/v2/order/?page_number=N   → 8 orders a page
//   detail: POST bff-gateway /pfs-postorder/api/v1/get-page/ORDER_DETAILS
//                                                           → the lines and packs
//
// Every call the site makes carries a per-call `request-signature`. Reads do
// not need it: our own fetch from inside the signed-in page is answered with
// three plain headers (the app version twice, and `auth_from_cookie`),
// measured on 2026-09-24. A read that one day starts to need the signature
// shows up here as CORS failures, which read as "unreachable", never as a
// logout: the household is not asked for an OTP over our breakage.
//
// The session is two cookies. `accessToken` is a JWT that lasts one hour and
// `refreshToken` renews it, so the session this job ends with may not be the
// one it started with: `renewedSession()` hands the cookies back to be sealed
// again, and a sync never leaves a stale token in the vault.
//
// Pack sizes come with the order detail, so `packLabel()` never calls out.
import type { Page } from 'playwright-core';

import {
  DEAD_ORDER_STATUSES,
  IMPORT_CALL_DELAY_MS,
  IMPORT_RETRY_BACKOFF_MS,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
  ZEPTO_API_ORIGIN,
  ZEPTO_APP_VERSION_HEADERS,
  ZEPTO_AUTH_FROM_COOKIE_HEADER,
  ZEPTO_DETAIL_MAX_PAGES,
  ZEPTO_DETAIL_PAGE_SIZE,
  ZEPTO_ORDER_DETAIL_PATH,
  ZEPTO_ORDERS_PATH,
  ZEPTO_ORIGIN,
  ZEPTO_SESSION_COOKIES,
} from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import type { CapturedSession } from '../connect.js';
import { ImportError, type ImportSession } from '../import/import.js';
import type { ParsedOrder } from '../import/instamart-parse.js';
import { linesFromDetail, nextDetailParams, parseZeptoList, zeptoOrder, zeptoOrderFromList, type ZeptoStub } from '../import/zepto-parse.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ZeptoResponse = { kind: 'ok'; json: unknown } | { kind: 'unauthorized' } | { kind: 'unreachable' };

// Zepto JSON with a 401 or 403 = the session is not accepted. Anything that is
// not Zepto JSON - a failed fetch (status -1: CORS, network), a 5xx, a rate
// limit, the WAF's HTML - is retryable and never a logout: telling a
// household to reconnect over a hiccup costs them an OTP.
export function classifyZeptoResponse(status: number, body: string): ZeptoResponse {
  if (status < 0 || status >= 500 || status === 429) return { kind: 'unreachable' };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'unreachable' };
  }
  if (status === 401 || status === 403) return { kind: 'unauthorized' };
  if (status === 200 && json && typeof json === 'object') return { kind: 'ok', json };
  return { kind: 'unreachable' };
}

// The headers a read needs, from the site's own build version.
export function readHeaders(appVersion: string): Record<string, string> {
  const h: Record<string, string> = { [ZEPTO_AUTH_FROM_COOKIE_HEADER]: 'true' };
  for (const name of ZEPTO_APP_VERSION_HEADERS) h[name] = appVersion;
  return h;
}

// The cookies worth sealing: the login and the ids, never the location
// cookies the site also sets (ZEPTO_SESSION_COOKIES).
export function sessionCookies(cookies: CapturedSession['cookies']): CapturedSession['cookies'] {
  return cookies.filter((c) => /(^|\.)zepto\.com$/.test(c.domain.replace(/^\./, '')) && ZEPTO_SESSION_COOKIES.includes(c.name));
}

async function inPage(page: Page, url: string, headers: Record<string, string>, json?: unknown) {
  const args = JSON.stringify({
    url,
    method: json === undefined ? 'GET' : 'POST',
    headers: json === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: json === undefined ? null : JSON.stringify(json),
  });
  return page.evaluate(`(async () => {
    const a = ${args};
    try {
      const r = await fetch(a.url, { method: a.method, credentials: 'include', headers: a.headers, body: a.body });
      return { status: r.status, body: await r.text() };
    } catch (e) {
      return { status: -1, body: '' };
    }
  })()`) as Promise<{ status: number; body: string }>;
}

// Exported for its tests, which drive it over a faked page.
export class ZeptoImportSession implements ImportSession {
  // Pack labels learned while listing: variant id → "500 g".
  private readonly packs = new Map<string, string>();
  // Refused once already this session: the page has been reloaded to let the
  // site renew its own token, and a second refusal is a real logout.
  private reloaded = false;

  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
    private readonly appVersion: () => string,
    private readonly delayMs: number,
    // Reload the site so it can renew an expired access token itself.
    private readonly reload: () => Promise<void>,
  ) {}

  private async withRetry<T>(attempt: () => Promise<T | 'retry'>): Promise<T> {
    for (let i = 0; ; i++) {
      const r = await attempt();
      if (r !== 'retry') return r;
      if (i >= IMPORT_RETRY_BACKOFF_MS.length) throw new ImportError('unreachable');
      await sleep(IMPORT_RETRY_BACKOFF_MS[i]);
    }
  }

  private async call(path: string, json?: unknown): Promise<unknown> {
    const once = () =>
      this.withRetry(async () => {
        const r = await inPage(this.page, `${ZEPTO_API_ORIGIN}${path}`, readHeaders(this.appVersion()), json);
        const c = classifyZeptoResponse(r.status, r.body);
        if (c.kind === 'unauthorized') throw new ImportError('unauthorized');
        return c.kind === 'unreachable' ? 'retry' : c.json;
      });
    try {
      return await once();
    } catch (err) {
      // The access token lasts an hour. The site renews it on its own load,
      // so one reload is tried before calling it a logout.
      if (!(err instanceof ImportError) || err.code !== 'unauthorized' || this.reloaded) throw err;
      this.reloaded = true;
      await this.reload();
      return once();
    }
  }

  private async detail(stub: ZeptoStub) {
    const lines = [];
    let next: Record<string, unknown> | null = {};
    for (let i = 0; next && i < ZEPTO_DETAIL_MAX_PAGES; i++) {
      const json = await this.call(ZEPTO_ORDER_DETAIL_PATH, {
        orderId: stub.id,
        page_size: ZEPTO_DETAIL_PAGE_SIZE,
        isArchived: stub.archived,
        enforce_platform_type: 'DESKTOP',
        ...next,
      });
      lines.push(...linesFromDetail(json));
      next = nextDetailParams(json);
      if (next) await sleep(this.delayMs);
    }
    return lines;
  }

  async listPage(cursor: unknown) {
    const pageNo = typeof cursor === 'number' ? cursor : 1;
    const list = parseZeptoList(await this.call(`${ZEPTO_ORDERS_PATH}?page_number=${pageNo}`));
    // Zepto JSON that is not an order list: its shape moved under us. Never a
    // logout, and never "no more orders" - that would end the history early.
    if (!list) throw new ImportError('unreachable');

    const orders: ParsedOrder[] = [];
    const packs = new Map<string, { sku: string; storeId: number; label: string }>();
    let detailed = 0;
    let empty = 0;
    for (const stub of list.stubs) {
      // An order that never arrived is never shown or counted: the list is
      // enough, and it saves a call.
      if (DEAD_ORDER_STATUSES.includes(stub.status)) {
        orders.push(zeptoOrderFromList(stub));
        continue;
      }
      await sleep(this.delayMs);
      const lines = await this.detail(stub);
      detailed++;
      // A detail with no lines we can read, for an order the list says had
      // some, is not stored: an order with no items would read as a shop that
      // bought nothing. It is picked up by a later relist once readable.
      if (lines.length === 0 && stub.lines.length > 0) {
        empty++;
        continue;
      }
      const parsed = zeptoOrder(stub, lines);
      orders.push(parsed.order);
      for (const [sku, label] of parsed.packs) {
        this.packs.set(sku, label);
        packs.set(sku, { sku, storeId: 0, label });
      }
    }
    // Every detail on the page unreadable is not a run of odd orders: the
    // detail's shape has changed. Stop loudly rather than store a history
    // with holes in it (design §9.10: partial data is worse than none).
    if (detailed > 0 && empty === detailed) throw new ImportError('internal');
    return { orders, nextCursor: list.endOfList || list.stubs.length === 0 ? null : pageNo + 1, packs: [...packs.values()] };
  }

  // The pack was on the order line. A sku we never listed is honestly
  // unknown - never a near match (design §8).
  async packLabel(sku: string): Promise<string | null> {
    return this.packs.get(sku) ?? null;
  }

  // The session as it stands now: the site may have renewed the hour-long
  // access token while this job ran, and that one is the one to keep.
  async renewedSession(): Promise<CapturedSession | null> {
    const cookies = sessionCookies(
      (await this.page.context().cookies(ZEPTO_ORIGIN)).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
      })),
    );
    return cookies.some((c) => c.name === 'accessToken') ? { cookies, localStorage: {} } : null;
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

// Load the site and learn its build version from its own first api call.
// Shared by connect, which needs the same page.
export async function openZeptoPage(page: Page): Promise<() => string> {
  let appVersion = '';
  page.on('request', (req) => {
    if (!req.url().startsWith(ZEPTO_API_ORIGIN)) return;
    const v = req.headers()[ZEPTO_APP_VERSION_HEADERS[0]];
    if (v) appVersion = v;
  });
  // The first answer is often a 202: AWS WAF's challenge, which the page
  // solves and reloads past by itself. So the status only rules out a
  // refusal; what proves the site came up is its own first api call.
  const res = await page.goto(`${ZEPTO_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
  if (!res || res.status() >= 300) throw new ImportError('unreachable');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  if (!appVersion) throw new ImportError('unreachable');
  return () => appVersion;
}

export function zeptoImportAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless(), delayMs: number = IMPORT_CALL_DELAY_MS) {
  return {
    async open(session: CapturedSession): Promise<ImportSession> {
      const hb = await launch();
      try {
        const context = hb.browser.contexts()[0];
        await context.addCookies(
          sessionCookies(session.cookies).map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires ?? -1,
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? false,
          })),
        );
        const page = await context.newPage();
        const version = await openZeptoPage(page);
        const reload = async () => {
          await page.reload({ waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
          await page.waitForTimeout(PAGE_SETTLE_MS);
        };
        return new ZeptoImportSession(hb, page, version, delayMs, reload);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}
