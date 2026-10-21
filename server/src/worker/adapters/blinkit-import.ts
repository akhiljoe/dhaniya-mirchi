// Blinkit import adapter (design §7.10, Appendix A) — ported from
// spike/blinkit/extract.ts, where it pulled a real history.
//
//   list:   POST /v1/layout/order_history          → ten order stubs a page
//   detail: POST /v1/layout/order_details/{orderId}?cart_id={cartId}
//                                                  → the line items and the date
//
// Two things Blinkit does that Instamart does not, both settled by probing the
// live account on 2026-09-20:
//   - **It does not page by offset.** `{offset, limit}` is ignored: offset 0
//     and offset 10 answered the same ten orders, and `limit: 50` answered
//     ten. The only way onwards is the `next_url` and `postback_params` the
//     page itself hands back, so that pair is the cursor (blinkit-parse.ts).
//   - **The list has no line items and no year.** Every order costs one detail
//     call, which is also the only place the date carries a year — so a full
//     history is one call per order, roughly 25 minutes for a few hundred orders at the
//     shared import delay.
//
// Pack sizes come free: a Blinkit line says "500 g x 1" in its own text, so
// listing an order teaches us its packs and `packLabel()` never calls out.
import type { Page } from 'playwright-core';

import { BLINKIT_ORIGIN, IMPORT_CALL_DELAY_MS, IMPORT_RETRY_BACKOFF_MS, PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS } from '../../constants.js';
import { launchHeadless, type HeadlessBrowser } from '../chrome.js';
import type { CapturedSession } from '../connect.js';
import { readStoredAddresses } from './blinkit.js';
import type { VendorAddress } from './instamart-catalog.js';
import { ImportError, type ImportSession } from '../import/import.js';
import type { ParsedOrder } from '../import/instamart-parse.js';
import { nextCursor, parseBlinkitOrder, stubsFromList, type BlinkitCursor } from '../import/blinkit-parse.js';
import { pickAppHeaders } from './blinkit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ListResponse = { kind: 'ok'; json: unknown } | { kind: 'unauthorized' } | { kind: 'unreachable' };

// Blinkit JSON without a snippet list = the session isn't accepted any more
// (reconnect). Not Blinkit JSON at all (the edge's HTML block page, a 5xx, a
// rate limit) = retryable, and never mistaken for a logout: telling a
// household to reconnect because an edge hiccuped costs them an OTP.
export function classifyListResponse(status: number, body: string): ListResponse {
  if (status >= 500 || status === 429) return { kind: 'unreachable' };
  let json: { response?: { snippets?: unknown } } | null;
  try {
    json = JSON.parse(body) as { response?: { snippets?: unknown } };
  } catch {
    return { kind: 'unreachable' };
  }
  if (status === 200 && Array.isArray(json?.response?.snippets)) return { kind: 'ok', json };
  return { kind: 'unauthorized' };
}

// `next_url` comes back either absolute or as a path.
export function absolutePath(url: string): string {
  if (url.startsWith('http')) return url;
  return url.startsWith('/') ? url : `/${url}`;
}

async function inPagePost(page: Page, path: string, body: unknown, headers: Record<string, string>) {
  const args = JSON.stringify({ path, body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json', ...headers } });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, { method: 'POST', credentials: 'include', headers: a.headers, body: a.body });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<{ status: number; body: string }>;
}

// Exported for its tests, which drive it over a faked page.
export class BlinkitImportSession implements ImportSession {
  // Pack labels learned while listing: sku → "500 g". Filled by listPage, read
  // by packLabel, so resolving packs costs no vendor call at all.
  private readonly packs = new Map<string, string>();

  constructor(
    private readonly hb: HeadlessBrowser,
    private readonly page: Page,
    private readonly headers: () => Record<string, string>,
    private readonly delayMs: number,
  ) {}

  private async withRetry<T>(attempt: () => Promise<T | 'retry'>): Promise<T> {
    for (let i = 0; ; i++) {
      const r = await attempt();
      if (r !== 'retry') return r;
      if (i >= IMPORT_RETRY_BACKOFF_MS.length) throw new ImportError('unreachable');
      await sleep(IMPORT_RETRY_BACKOFF_MS[i]);
    }
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    return this.withRetry(async () => {
      const r = await inPagePost(this.page, path, body, this.headers());
      const c = classifyListResponse(r.status, r.body);
      if (c.kind === 'unauthorized') throw new ImportError('unauthorized');
      return c.kind === 'unreachable' ? 'retry' : c.json;
    });
  }

  async listPage(cursor: unknown) {
    const c = cursor as BlinkitCursor | null;
    const path = c ? absolutePath(c.url) : '/v1/layout/order_history';
    const list = await this.call(path, c ? c.body : {});

    const orders: ParsedOrder[] = [];
    // Handed back to the runner and stored as this page is read: these labels
    // exist nowhere else, so a job that stops before the packs step must not
    // lose them (design §8).
    const packs = new Map<string, { sku: string; storeId: number; label: string }>();
    for (const stub of stubsFromList(list)) {
      const detail = await this.call(`/v1/layout/order_details/${encodeURIComponent(stub.orderId)}?cart_id=${encodeURIComponent(stub.cartId)}`, {});
      const parsed = parseBlinkitOrder(stub, detail);
      // No date on the detail page: left for a later sync rather than stored
      // on a guessed year (Appendix B — that guess lost most of the orders).
      if (parsed) {
        orders.push(parsed.order);
        for (const [sku, label] of parsed.packs) {
          this.packs.set(sku, label);
          // storeId 0: Blinkit has no per-store catalog of its own here, and
          // the line items are stored the same way (blinkit-parse.ts).
          packs.set(sku, { sku, storeId: 0, label });
        }
      }
      await sleep(this.delayMs);
    }
    return { orders, nextCursor: nextCursor(list), packs: [...packs.values()] };
  }

  // Blinkit has no catalog call we need: the pack was on the order line. A sku
  // we never listed is honestly unknown — never a near match (design §8).
  async packLabel(sku: string): Promise<string | null> {
    return this.packs.get(sku) ?? null;
  }

  // Free here: `open()` has already loaded the home page, which is what
  // fetches the addresses into the client's own cache (design Appendix A).
  // Reading it costs no call and touches no cart.
  async addresses(): Promise<VendorAddress[]> {
    try {
      const raw = (await this.page.evaluate(`localStorage.getItem('addressesV2')`)) as string | null;
      return readStoredAddresses(raw ?? undefined);
    } catch {
      return [];
    }
  }

  // The vendor's checkout reads `localStorage.user`, not the token: a session
  // whose login went through our own fetch has the token and an empty user,
  // and is refused at the cart page while every API call keeps working
  // (design Appendix A). So this is the question, and the page already holds
  // the answer - it costs no call.
  async checkoutReady(): Promise<boolean | null> {
    try {
      const raw = (await this.page.evaluate(`localStorage.getItem('user')`)) as string | null;
      if (!raw) return null;
      const user = JSON.parse(raw) as { verified?: unknown; id?: unknown };
      return user?.verified === true && !!user?.id;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.hb.close();
  }
}

export function blinkitImportAdapter(
  launch: () => Promise<HeadlessBrowser> = () => launchHeadless(),
  delayMs: number = IMPORT_CALL_DELAY_MS,
) {
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
        // Blinkit keeps the login in localStorage (Appendix A), so it must be
        // there before the site's own scripts read it.
        await context.addInitScript(
          `if (location.origin === ${JSON.stringify(BLINKIT_ORIGIN)}) {
             const s = ${JSON.stringify(session.localStorage)};
             for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
           }`,
        );
        const page = await context.newPage();
        // The device headers are read off the page's own calls, never invented.
        let headers: Record<string, string> = {};
        page.on('request', (req) => {
          const url = req.url();
          if (!url.startsWith(`${BLINKIT_ORIGIN}/v1/`)) return;
          const picked = pickAppHeaders(req.headers());
          if (picked.auth_key && picked.device_id) headers = { ...picked, ...(req.headers().access_token ? { access_token: req.headers().access_token } : {}) };
        });
        const res = await page.goto(`${BLINKIT_ORIGIN}/`, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        if (!res || res.status() !== 200) throw new ImportError('unreachable');
        await page.waitForTimeout(PAGE_SETTLE_MS);
        if (!Object.keys(headers).length) throw new ImportError('unreachable');
        return new BlinkitImportSession(hb, page, () => headers, delayMs);
      } catch (err) {
        await hb.close();
        throw err;
      }
    },
  };
}
