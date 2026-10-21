// What does Blinkit's own checkout say, through the page the worker drives?
//
//   cd server
//   npx tsx --env-file=../.env scripts/blinkit-screen-probe.ts
//
// The worker reaches this screen and then reports what it found - a total, an
// item count, a list of cards - and every live failure so far has been one of
// those three coming back wrong. Reading them here takes one run instead of
// asking the household to try a payment and tell us what they saw.
//
// WHAT IT DOES: opens the household's cart in a real browser, presses the
// vendor's own Proceed, and prints the payment screen as the worker sees it.
//
// WHAT IT DOES NOT DO: type a CVV, press Pay Now, or place an order. It never
// calls pay(). Nothing here can move money.
//
// It needs CHROME_PATH and CHROME_VERSION on Windows (see .env.example).
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { openSealed } from '../src/vault.js';
import { blinkitPageAdapter } from '../src/worker/adapters/blinkit-page.js';
import { readStoredAddresses } from '../src/worker/adapters/blinkit.js';
import { launchHeadless } from '../src/worker/chrome.js';
import type { CapturedSession } from '../src/worker/connect.js';

const PHONE_LAST4 = process.env.PROBE_PHONE_LAST4 ?? '4567';

const e = process.env;
const dbUrl = `postgres://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? '5435'}/${e.POSTGRES_DB}`;
const db = createDb(dbUrl);
const config = loadConfig({ ...e, DATABASE_URL: dbUrl } as Record<string, string>);

const { rows } = await db.query<{ id: string; session_sealed: string; addresses: unknown; cart_address: unknown }>(
  "select id, session_sealed, addresses, cart_address from vendor_connections where vendor = 'blinkit' and phone_last4 = $1",
  [PHONE_LAST4],
);
if (!rows.length) throw new Error(`no Blinkit connection ending ${PHONE_LAST4}`);

const saved = readStoredAddresses(JSON.stringify({ addresses_data: rows[0].addresses }));
const chosen = rows[0].cart_address as { id?: string | number; label?: string } | null;
const where = saved.find((a) => String(a.id) === String(chosen?.id)) ?? saved[0];
if (!where) throw new Error('this account has no saved address');

const session = JSON.parse(
  openSealed(config.vault.privateKeys, rows[0].session_sealed, `vendor_connections:${rows[0].id}:session`),
) as CapturedSession;

console.log(`address  : ${where.label ?? where.id}`);

const s = await blinkitPageAdapter(() => launchHeadless(e.CHROME_PATH, e.CHROME_VERSION)).open(session, where);
if (process.env.PROBE_PAYAPI) {
  const hits: string[] = [];
  (globalThis as unknown as { __payHits: string[] }).__payHits = hits;
  const page = (s as unknown as { page: { on(ev: string, fn: (r: unknown) => void): void } }).page;
  page.on('response', (r) => {
    const res = r as { url(): string; text(): Promise<string> };
    void res
      .text()
      .then((body) => {
        if (!/blinkit\s*money|wallet_balance|walletBalance|"wallet"/i.test(body)) return;
        const where = body.search(/blinkit\s*money|wallet_balance|walletBalance/i);
        hits.push(`payapi   : ${res.url().slice(0, 80)}
   ...${body.slice(Math.max(0, where - 120), where + 240)}`);
      })
      .catch(() => undefined);
  });
}
try {
  // PROBE_ADD puts one thing in the cart and stops. Run it once, then run
  // this script again without it: the second run is a different browser with
  // the same stored session, so the count it prints answers the question the
  // whole refill decision rests on - does this vendor's cart belong to the
  // account, or to the browser that filled it?
  if (process.env.PROBE_ADD) {
    const line = await s.set({ item: 'probe', product: process.env.PROBE_ADD, pack: '', qty: 1, match: 'search' as const });
    console.log(`added    : ${line.state} | ${line.product} | in cart ${line.inCart}${line.note ? ` | ${line.note}` : ''}`);
  }
  // PROBE_API_ADD=<product_id>: does the vendor's OWN cart call fill the cart
  // its checkout shows, when the call is made from inside the signed-in page?
  //
  // The standing finding is that it does not - `POST /v5/carts` fills a cart
  // the checkout cannot see - but that was measured from a separate browser
  // context with its own device id. From in here the call carries the page's
  // cookies, its device id and its merchant, which is a different question
  // and the difference between a cart filled in a second and one filled in a
  // minute.
  // What the page puts on its OWN api calls. Our call has to carry the same
  // things, and they cannot be invented - they say which app and which device
  // is speaking.
  if (process.env.PROBE_HEADERS) {
    const page = (s as unknown as {
      page: {
        on(e: string, fn: (r: { url(): string; headers(): Record<string, string> }) => void): void;
        goto(u: string, o: unknown): Promise<unknown>;
      };
    }).page;
    const seen = new Map<string, Record<string, string>>();
    page.on('request', (r) => {
      if (/blinkit\.com\/(v\d|mapi)/.test(r.url())) seen.set(r.url().split('?')[0], r.headers());
    });
    await page.goto('https://blinkit.com/s/?q=milk', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await new Promise((ok) => setTimeout(ok, 6000));
    for (const [url, h] of [...seen].slice(0, 3)) {
      console.log(`\nreq      : ${url}`);
      for (const [k, v] of Object.entries(h)) {
        if (/^(cookie|authorization|auth_key|access_token)$/i.test(k)) continue;
        console.log(`   ${k} = ${v.slice(0, 60)}`);
      }
    }
  }
  if (process.env.PROBE_API_ADD) {
    const session = s as unknown as {
      call(p: string, m: 'GET' | 'POST' | 'PUT', b?: unknown): Promise<{ status: number; body: string }>;
    };
    const body = { items: [{ product_id: Number(process.env.PROBE_API_ADD), quantity: 1 }], promo_codes: [''] };
    const r = await session.call('/v5/carts', 'POST', body);
    console.log(`api add  : HTTP ${r.status} | ${r.body.slice(0, 700)}`);
  }
  // PROBE_SAVE / PROBE_LOAD: can the cart the checkout shows be carried from
  // one browser to another? It is not on the vendor's server - two browsers
  // with the SAME device id saw an empty cart minutes after one of them
  // filled it - so it is here, or it cannot be done at all.
  const store = (s as unknown as { page: { evaluate(fn: string): Promise<unknown>; goto(u: string, o: unknown): Promise<unknown> } }).page;
  if (process.env.PROBE_LOAD) {
    const blob = (await import('node:fs')).readFileSync(process.env.PROBE_LOAD, 'utf8');
    await store.evaluate(`localStorage.setItem('cart', ${JSON.stringify(blob)})`);
    // Read back through the page's own boot, which is what a payment would do.
    await store.goto('https://blinkit.com/cart', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    console.log(`loaded   : ${blob.length} bytes of cart put back`);
  }
  // Where the page keeps the cart it shows. The vendor has two carts and its
  // checkout only shows this one, so if it is in the browser's own storage
  // then it can be carried from the job that fills it to the job that pays.
  if (process.env.PROBE_STORE) {
    const page = (s as unknown as { page: { evaluate(fn: string): Promise<unknown> } }).page;
    const keys = (await page.evaluate(
      `(() => {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k) || '';
          out.push({ k, n: v.length, head: v.slice(0, 90) });
        }
        return out.sort((a, b) => b.n - a.n);
      })()`,
    )) as { k: string; n: number; head: string }[];
    for (const { k, n, head } of keys) console.log(`ls ${String(n).padStart(6)}  ${k.padEnd(22)} ${head}`);
  }
  // What this browser calls itself. This vendor's cart belongs to a device,
  // not to an account, so if the id differs between two runs of this script
  // then the cart cannot survive between them and never could.
  if (process.env.PROBE_IDS) {
    const page = (s as unknown as { page: { evaluate(fn: string): Promise<unknown>; context(): { cookies(): Promise<{ name: string; value: string }[]> } } }).page;
    const ids = (await page.evaluate(
      `(() => {
        const out = {};
        for (const k of ['deviceId', 'device_id', 'gr_device_id']) out[k] = localStorage.getItem(k);
        return out;
      })()`,
    )) as Record<string, string | null>;
    for (const [k, v] of Object.entries(ids)) if (v) console.log(`${k.padEnd(9)}: ${v}`);
    const cookies = await page.context().cookies();
    for (const c of cookies) if (/device|gr_1|cart/i.test(c.name)) console.log(`cookie   : ${c.name} = ${c.value.slice(0, 40)}`);
  }
  // The cart as the vendor holds it. This is the number the worker now uses
  // to decide whether a cart survived into a new browser.
  const count = await (s as unknown as { bk: { cartCount(): Promise<number> } }).bk.cartCount();
  console.log(`cart     : ${count} ${count === 1 ? 'item' : 'items'} by the vendor's own count`);
  // The page's own words behind that number. A count of zero is either an
  // empty cart or a misread, and those are fixed in opposite places.
  if (process.env.PROBE_DUMP) {
    const page = (s as unknown as { page: { url(): string; locator(sel: string): { innerText(): Promise<string> } } }).page;
    const said = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`url      : ${page.url()}`);
    console.log(`page says: ${said.slice(0, 600)}`);
  }
  if (process.env.PROBE_SAVE) {
    const blob = ((await store.evaluate(`localStorage.getItem('cart')`)) as string | null) ?? '';
    (await import('node:fs')).writeFileSync(process.env.PROBE_SAVE, blob);
    console.log(`saved    : ${blob.length} bytes of cart`);
  }
  if (!count) {
    console.log('\nNothing in the cart, so there is no checkout to open. Send a cart from the app first.');
  } else {
    const checkout = s.checkout!();
    const screen = await checkout.open();
    console.log(`total    : Rs ${screen.total ?? 'NOT READ'}`);
    console.log(`items    : ${screen.items ?? 'NOT READ'}`);
    console.log(`address  : ${screen.address ?? 'NOT READ'}`);
    console.log(`on deliv : ${screen.onDelivery}`);
    console.log(`cards    : ${screen.cards.length ? screen.cards.join(' | ') : 'NONE FOUND'}`);
    console.log(`cvv now  : ${await checkout.cvvNeeded()}`);
    // Every answer the checkout got, searched for a prepaid balance. If the
  // wallet is on the account but not on this screen, the payload says so and
  // the difference is the vendor's, not ours.
  if (process.env.PROBE_PAYAPI) {
    const hits = (globalThis as unknown as { __payHits?: string[] }).__payHits ?? [];
    for (const h of hits) console.log(h);
    if (!hits.length) console.log('payapi   : nothing mentioning a wallet balance');
  }
  // Open the Wallets section and see what is actually in it. A prepaid
    // balance would need no CVV and no bank code, which is a different and
    // much shorter payment than the card one.
    if (process.env.PROBE_WALLET) {
      const page = (s as unknown as {
        page: {
          frames(): {
            url(): string;
            locator(sel: string): {
              filter(o: unknown): { first(): { click(o: unknown): Promise<void>; count(): Promise<number> } };
            };
            waitForTimeout(ms: number): Promise<void>;
            locator2?: unknown;
          }[];
        };
      }).page;
      for (const f of page.frames()) {
        if (!f.url().includes('zpaykit')) continue;
        const section = f.locator('*').filter({ hasText: /^Wallets$/ }).first();
        if (await section.count()) {
          await section.click({ timeout: 15_000 }).catch(() => undefined);
          await f.waitForTimeout(3000);
          console.log('wallets  : opened');
        }
      }
    }
    // Every way this account is offered to pay, in the screen's own words.
    // Looking for a prepaid balance ("Blinkit Money"), which would need no
    // CVV and no bank code at all.
    if (process.env.PROBE_METHODS) {
      const page = (s as unknown as { page: { frames(): { url(): string; locator(sel: string): { innerText(): Promise<string> } }[] } }).page;
      for (const f of page.frames()) {
        const said = (await f.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (!said) continue;
        console.log(`\nframe    : ${f.url().slice(0, 70)}`);
        console.log(said.slice(0, 1200));
      }
    }
  }
} finally {
  await s.close();
  await db.end();
}
