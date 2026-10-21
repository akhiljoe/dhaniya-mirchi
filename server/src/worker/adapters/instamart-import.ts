// Instamart import adapter (design §7.10, Appendix C) — ported from
// spike/instamart/extract.ts, where it pulled a year of real history with no
// gaps and no rate limiting at ~1.2 s per call.
//
//   orders: GET /api/instamart/orders?order_type=DASH&count=20&from_time=<ms>
//           newest first; the next page is from the oldest order + 1 ms (an
//           order sharing that millisecond is re-fetched, and deduped, rather
//           than skipped).
//   packs:  POST /api/instamart/search/v2 at the item's own store; accept only
//           the variation whose skuId equals the ordered SKU — never the
//           nearest match (design §8: a wrong pack corrupts every prediction).
//
// The sealed session is restored into a FRESH headless profile: cookies added
// to the context, localStorage set before the site's own scripts run.
import type { Page } from 'playwright-core';

import {
  IMPORT_RETRY_BACKOFF_MS,
  INSTAMART_ORDERS_PAGE_SIZE,
  INSTAMART_ORIGIN,
  PAGE_LOAD_TIMEOUT_MS,
  PAGE_SETTLE_MS,
} from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import type { CapturedSession } from '../connect.js';
import { ImportError, type ImportSession } from '../import/import.js';
import { parseInstamartOrder, type InstamartRawOrder } from '../import/instamart-parse.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type OrdersResponse = { kind: 'ok'; orders: InstamartRawOrder[] } | { kind: 'unauthorized' } | { kind: 'unreachable' };

// Instamart JSON without an orders list = the session isn't accepted (reconnect).
// Not Instamart JSON at all (a bot-challenge page, a 5xx, a rate limit) =
// retryable — never mistaken for a logout.
export function classifyOrdersResponse(status: number, body: string): OrdersResponse {
  if (status >= 500 || status === 429) return { kind: 'unreachable' };
  let json: { data?: { orders?: unknown } } | null;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'unreachable' };
  }
  const orders = json?.data?.orders;
  if (status === 200 && Array.isArray(orders)) return { kind: 'ok', orders: orders as InstamartRawOrder[] };
  return { kind: 'unauthorized' };
}

export function nextOrdersCursor(orders: InstamartRawOrder[]): number | null {
  if (orders.length === 0) return null;
  return Math.min(...orders.map((o) => o.created_at)) + 1;
}

// The pack label of the variation whose skuId is exactly `sku`, anywhere in a
// search response, or null. Never a near match.
export function exactPackLabel(response: unknown, sku: string): string | null {
  const stack: unknown[] = [response];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.skuId === sku && typeof o.quantityDescription === 'string') return o.quantityDescription;
      stack.push(...Object.values(o));
    }
  }
  return null;
}

async function inPage(page: Page, path: string, init: { method: 'GET' | 'POST'; json?: unknown }) {
  const args = JSON.stringify({
    path,
    method: init.method,
    body: init.json === undefined ? null : JSON.stringify(init.json),
  });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, {
      method: a.method,
      credentials: 'include',
      headers: a.body ? { 'content-type': 'application/json' } : {},
      body: a.body,
    });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

class InstamartImportSession implements ImportSession {
  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
  ) {}

  // Retry transient failures with back-off; a logout is never retried.
  private async withRetry<T>(attempt: () => Promise<T | 'retry'>): Promise<T> {
    for (let i = 0; ; i++) {
      const r = await attempt();
      if (r !== 'retry') return r;
      if (i >= IMPORT_RETRY_BACKOFF_MS.length) throw new ImportError('unreachable');
      await sleep(IMPORT_RETRY_BACKOFF_MS[i]);
    }
  }

  async listPage(cursor: unknown) {
    const fromTime = typeof cursor === 'number' ? cursor : Date.now();
    const path = `/api/instamart/orders?order_type=DASH&count=${INSTAMART_ORDERS_PAGE_SIZE}&from_time=${fromTime}`;
    const orders = await this.withRetry(async () => {
      const r = await inPage(this.page, path, { method: 'GET' });
      const c = classifyOrdersResponse(r.status, r.body);
      if (c.kind === 'unauthorized') throw new ImportError('unauthorized');
      return c.kind === 'unreachable' ? 'retry' : c.orders;
    });
    return { orders: orders.map(parseInstamartOrder), nextCursor: nextOrdersCursor(orders) };
  }

  async packLabel(sku: string, storeId: number, name: string): Promise<string | null> {
    // storeId and primaryStoreId must both be the item's own store — mixing
    // stores returns results without the ordered SKU (Appendix C).
    const path = `/api/instamart/search/v2?offset=0&ageConsent=false&storeId=${storeId}&primaryStoreId=${storeId}&secondaryStoreId=`;
    const body = {
      facets: [],
      sortAttribute: '',
      query: name,
      search_results_offset: '0',
      page_type: 'INSTAMART_SEARCH_PAGE',
      is_pre_search_tag: false,
    };
    return this.withRetry(async () => {
      const r = await inPage(this.page, path, { method: 'POST', json: body });
      if (r.status !== 200) return 'retry';
      try {
        return exactPackLabel(JSON.parse(r.body), sku);
      } catch {
        return 'retry'; // an HTML challenge page served with 200
      }
    });
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

export function instamartImportAdapter(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()) {
  return {
    async open(session: CapturedSession): Promise<ImportSession> {
      const hb = await launch();
      try {
        const context = hb.browser.contexts()[0];
        await context.addCookies(
          session.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires ?? -1,
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? false,
          })),
        );
        // localStorage must exist before the site's own scripts read it.
        await context.addInitScript(
          `if (location.origin === ${JSON.stringify(INSTAMART_ORIGIN)}) {
             const s = ${JSON.stringify(session.localStorage)};
             for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
           }`,
        );
        const page = await context.newPage();
        const res = await page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        if (!res || res.status() !== 200) throw new ImportError('unreachable');
        await page.waitForTimeout(PAGE_SETTLE_MS);
        return new InstamartImportSession(hb, page);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}
