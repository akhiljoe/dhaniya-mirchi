// Instamart spike — full extraction.
//
// Pulls Instamart order history end to end and writes orders.json in the same
// lean shape as spike/blinkit (so the two can be merged). Runs inside the
// logged-in instamart.in page in the spike Chrome (see shared.ts for why a
// Playwright-launched browser is not used). Log in first with `npm run capture`.
//
//   npm run extract                 # everything
//   MAX_ORDERS=100 npm run extract  # stop once 100 orders are cached
//
// Two stages, each cached so a re-run (after a 429, a crash, a closed window)
// resumes instead of starting over:
//
// 1. Orders — GET /api/instamart/orders?order_type=DASH&count=20&from_time=<ms>
//    Newest first, 20 per page (the server caps `count` at 20). The next page
//    is `from_time` = the oldest `created_at` on this page (+1 ms). Items are
//    embedded: order_data.orders[].order_jobs[].metadata is a JSON *string*
//    whose bill.billedItems[] carry name, SKU, store, quantity, price.
//    Raw orders → orders_raw.json (PII: address, phone — gitignored).
//
// 2. Packs — the order payload has NO pack size ("Amul Gold ... Milk", no
//    "500 ml"). The catalog has it, keyed by SKU. SKUs are store-specific, so
//    we search the item's name at its own store and accept ONLY the variant
//    whose skuId equals the ordered SKU. No exact match → pack unknown (never
//    guessed — design §8). Cached per SKU+store in packs.json.
//
// Lean output (orders.json):
//   { orderId, placedAt, status, total, address, source: 'instamart',
//     items: [ { name, pack, unit, count, pricePaid, sku } ] }
// `address` is the saved-address label + area only (e.g. "Home · Indiranagar")
// for the address filter (design §7.9); flat no., phone, name, lat/lng are
// dropped here.
//
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { attachChrome, openInstamartPage, pageFetch, parsePackLabel, sleep } from './shared.ts';

const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? Infinity);
const PAGE_SIZE = 20; // server cap
const DELAY_MS = Number(process.env.DELAY_MS ?? 1200); // between API calls
const BACKOFF_MS = [5_000, 15_000, 45_000];

const RAW_FILE = 'orders_raw.json';
const PACKS_FILE = 'packs.json';
const OUT_FILE = 'orders.json';

// ---------------------------------------------------------------- types

interface RawOrder {
  order_id: string;
  created_at: number; // epoch ms
  history_status: string;
  order_data: { orders: { order_jobs: { metadata: string }[] }[] };
  order_data_v2?: { total?: { units?: number; nanos?: number } };
}

interface BilledItem {
  item: { itemId: string; storeId: number; quantity: number; name: string };
  bill: { totalCost?: number; quantity?: number };
}

interface JobMeta {
  address?: { annotation?: string; area?: string };
  bill?: { billedItems?: BilledItem[] };
}

interface PackEntry {
  sku: string;
  store: number;
  name: string;
  label: string | null; // catalog quantityDescription, e.g. "500 ml"; null = not found
  spinId: string | null;
  status: number; // HTTP status of the search that resolved it
}

interface LineItem {
  name: string;
  pack: number | null;
  unit: string; // ml | l | g | kg | piece | unknown
  count: number;
  pricePaid: number | null;
  sku: string;
}

interface Order {
  orderId: string;
  placedAt: string;
  status: string;
  total: number | null;
  address: string | null;
  source: 'instamart';
  items: LineItem[];
}

// ---------------------------------------------------------------- fetch with backoff

// One API call with backoff on 429 / 5xx / non-JSON (a WAF challenge page).
// Returns null when retries are exhausted — the caller saves and stops, and a
// re-run resumes from the cache.
async function call(page: Page, path: string, init?: Parameters<typeof pageFetch>[2]): Promise<unknown | null> {
  for (let attempt = 0; ; attempt++) {
    const r = await pageFetch(page, path, init);
    let json: unknown = null;
    if (r.status === 200) {
      try {
        json = JSON.parse(r.body);
      } catch {
        json = null; // HTML challenge/error page served with 200
      }
    }
    if (json !== null) return json;
    if (attempt >= BACKOFF_MS.length) {
      console.warn(`[give up] ${r.status} ${path.split('?')[0]} — re-run to resume`);
      return null;
    }
    console.warn(`[retry] ${r.status} ${path.split('?')[0]}, waiting ${BACKOFF_MS[attempt] / 1000}s`);
    await sleep(BACKOFF_MS[attempt]);
  }
}

// ---------------------------------------------------------------- stage 1: orders

function loadRaw(): Map<string, RawOrder> {
  const m = new Map<string, RawOrder>();
  if (existsSync(RAW_FILE)) for (const o of JSON.parse(readFileSync(RAW_FILE, 'utf8')) as RawOrder[]) m.set(o.order_id, o);
  return m;
}

function saveRaw(m: Map<string, RawOrder>): void {
  const arr = [...m.values()].sort((a, b) => b.created_at - a.created_at);
  writeFileSync(RAW_FILE, JSON.stringify(arr));
}

async function fetchPage(page: Page, fromTime: number): Promise<RawOrder[] | null> {
  const j = (await call(page, `/api/instamart/orders?order_type=DASH&count=${PAGE_SIZE}&from_time=${fromTime}`)) as {
    data?: { orders?: RawOrder[] };
  } | null;
  if (!j) return null;
  return j.data?.orders ?? [];
}

// Newest first until we reach orders already cached, then continue from the
// oldest cached order back to the start of history.
async function syncOrders(page: Page, raw: Map<string, RawOrder>): Promise<boolean> {
  // (a) new orders since the last run
  let from = Date.now();
  for (;;) {
    const got = await fetchPage(page, from);
    if (got === null) return false;
    const fresh = got.filter((o) => !raw.has(o.order_id));
    for (const o of fresh) raw.set(o.order_id, o);
    if (got.length) console.log(`orders: +${fresh.length} newer (cached ${raw.size})`);
    saveRaw(raw);
    if (got.length < PAGE_SIZE || fresh.length < got.length || raw.size >= MAX_ORDERS) break;
    from = got[got.length - 1].created_at + 1; // +1: re-include the boundary (dedup'd) so a tie is never skipped
    await sleep(DELAY_MS);
  }

  // (b) older history, from the oldest cached order backwards
  while (raw.size > 0 && raw.size < MAX_ORDERS) {
    const oldest = Math.min(...[...raw.values()].map((o) => o.created_at));
    await sleep(DELAY_MS);
    const got = await fetchPage(page, oldest + 1); // +1: see above
    if (got === null) return false;
    const fresh = got.filter((o) => !raw.has(o.order_id));
    for (const o of fresh) raw.set(o.order_id, o);
    saveRaw(raw);
    if (fresh.length === 0) break; // reached the start of history
    console.log(
      `orders: +${fresh.length} older, back to ${new Date(got[got.length - 1].created_at).toISOString().slice(0, 10)} (cached ${raw.size})`,
    );
  }
  return true;
}

// ---------------------------------------------------------------- stage 2: packs

const packKey = (sku: string, store: number) => `${sku}@${store}`;

function loadPacks(): Map<string, PackEntry> {
  const m = new Map<string, PackEntry>();
  if (existsSync(PACKS_FILE))
    for (const p of JSON.parse(readFileSync(PACKS_FILE, 'utf8')) as PackEntry[]) m.set(packKey(p.sku, p.store), p);
  return m;
}

function savePacks(m: Map<string, PackEntry>): void {
  writeFileSync(PACKS_FILE, JSON.stringify([...m.values()], null, 1));
}

interface SearchVariation {
  skuId?: string;
  spinId?: string;
  quantityDescription?: string;
}

// Every catalog variation object anywhere in a search response.
function collectVariations(v: unknown, out: SearchVariation[] = []): SearchVariation[] {
  if (Array.isArray(v)) {
    for (const x of v) collectVariations(x, out);
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.skuId === 'string' && typeof o.quantityDescription === 'string') out.push(o as SearchVariation);
    for (const x of Object.values(o)) collectVariations(x, out);
  }
  return out;
}

async function resolvePack(page: Page, sku: string, store: number, name: string): Promise<PackEntry | null> {
  // storeId and primaryStoreId must both be the item's own store — mixing
  // stores returns results without the ordered SKU.
  const path = `/api/instamart/search/v2?offset=0&ageConsent=false&storeId=${store}&primaryStoreId=${store}&secondaryStoreId=`;
  const j = await call(page, path, {
    method: 'POST',
    json: {
      facets: [],
      sortAttribute: '',
      query: name,
      search_results_offset: '0',
      page_type: 'INSTAMART_SEARCH_PAGE',
      is_pre_search_tag: false,
    },
  });
  if (j === null) return null;
  const exact = collectVariations(j).find((v) => v.skuId === sku);
  return {
    sku,
    store,
    name,
    label: exact?.quantityDescription ?? null,
    spinId: exact?.spinId ?? null,
    status: 200,
  };
}

// ---------------------------------------------------------------- lean conversion

function jobsOf(o: RawOrder): JobMeta[] {
  const out: JobMeta[] = [];
  for (const sub of o.order_data?.orders ?? []) {
    for (const job of sub.order_jobs ?? []) {
      try {
        out.push(JSON.parse(job.metadata) as JobMeta);
      } catch {
        // a job without parseable metadata carries no items
      }
    }
  }
  return out;
}

function toLean(o: RawOrder, packs: Map<string, PackEntry>): Order {
  const jobs = jobsOf(o);
  const addr = jobs.find((j) => j.address)?.address;
  const items: LineItem[] = [];
  for (const job of jobs) {
    for (const b of job.bill?.billedItems ?? []) {
      // Promo add-ons ("Sample - Nivea Soft Sachet", "Flyer - Sid's Farm") are
      // not purchases — same rule as the Blinkit extract.
      if (/^\s*(sample|flyer)\b|\b(trial|free gift|freebie)\b/i.test(b.item.name)) continue;
      const p = packs.get(packKey(b.item.itemId, b.item.storeId));
      const parsed = p?.label ? parsePackLabel(p.label) : null;
      items.push({
        name: b.item.name,
        pack: parsed?.pack ?? null,
        unit: parsed?.unit ?? 'unknown',
        count: b.item.quantity,
        pricePaid: typeof b.bill?.totalCost === 'number' ? b.bill.totalCost : null,
        sku: b.item.itemId,
      });
    }
  }
  const t = o.order_data_v2?.total;
  return {
    orderId: o.order_id,
    placedAt: new Date(o.created_at).toISOString(),
    status: o.history_status,
    total: t && typeof t.units === 'number' ? t.units + (t.nanos ?? 0) / 1e9 : null,
    address: addr ? [addr.annotation, addr.area].filter(Boolean).join(' · ') || null : null,
    source: 'instamart',
    items,
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const browser = await attachChrome();
  const page = await openInstamartPage(browser);

  const raw = loadRaw();
  console.log(`cached orders: ${raw.size}`);
  const ordersOk = await syncOrders(page, raw);

  // Packs for every distinct SKU on a DELIVERED order (failed/cancelled orders
  // are not purchases and need no pack).
  const packs = loadPacks();
  const want = new Map<string, { sku: string; store: number; name: string }>();
  for (const o of raw.values()) {
    if (o.history_status !== 'DELIVERED') continue;
    for (const job of jobsOf(o))
      for (const b of job.bill?.billedItems ?? []) {
        const k = packKey(b.item.itemId, b.item.storeId);
        if (!packs.has(k)) want.set(k, { sku: b.item.itemId, store: b.item.storeId, name: b.item.name });
      }
  }
  console.log(`\npacks: ${packs.size} cached, resolving ${want.size} new SKUs...`);
  let n = 0;
  let packsOk = true;
  for (const w of want.values()) {
    await sleep(DELAY_MS);
    const p = await resolvePack(page, w.sku, w.store, w.name);
    if (!p) {
      packsOk = false;
      break;
    }
    packs.set(packKey(p.sku, p.store), p);
    n++;
    if (n % 10 === 0 || n === want.size) {
      savePacks(packs);
      console.log(`packs: ${n}/${want.size}`);
    }
  }
  savePacks(packs);
  await page.close();

  // Lean orders, newest first.
  const orders = [...raw.values()].sort((a, b) => b.created_at - a.created_at).map((o) => toLean(o, packs));
  writeFileSync(OUT_FILE, JSON.stringify(orders, null, 2));

  // Names-only distinct list for normalization — no prices, dates, or address.
  const distinct = new Map<string, { name: string; count: number; units: Record<string, number> }>();
  for (const o of orders) {
    if (o.status !== 'DELIVERED') continue;
    for (const it of o.items) {
      const e = distinct.get(it.name) ?? { name: it.name, count: 0, units: {} };
      e.count++;
      const u = `${it.pack ?? ''}${it.unit}`;
      e.units[u] = (e.units[u] ?? 0) + 1;
      distinct.set(it.name, e);
    }
  }
  const distinctArr = [...distinct.values()].sort((a, b) => b.count - a.count);
  writeFileSync('distinct_products.json', JSON.stringify(distinctArr, null, 2));

  const delivered = orders.filter((o) => o.status === 'DELIVERED');
  const lines = delivered.flatMap((o) => o.items);
  const known = lines.filter((it) => it.pack !== null).length;
  const statuses = orders.reduce((m: Record<string, number>, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {});
  const span = delivered.length ? `${delivered.at(-1)!.placedAt.slice(0, 10)} → ${delivered[0].placedAt.slice(0, 10)}` : '-';

  console.log('\n=== done ===');
  console.log(`orders: ${orders.length}  ${JSON.stringify(statuses)}`);
  console.log(`delivered span: ${span}`);
  console.log(`line items (delivered): ${lines.length}; pack known: ${known} (${lines.length ? Math.round((100 * known) / lines.length) : 0}%)`);
  console.log(`distinct products: ${distinctArr.length} → distinct_products.json (names only)`);
  console.log(`saved ${OUT_FILE} (gitignored — real purchase data)`);
  if (!ordersOk || !packsOk) console.log('\n[incomplete] stopped on repeated errors — re-run `npm run extract` to resume.');

  console.log('\nsample line items (name — pack x count):');
  for (const it of lines.slice(0, 12)) console.log(`  ${it.name} — ${it.pack ?? '?'}${it.unit} x ${it.count}`);

  process.exit(0); // disconnect only — never close the user's Chrome
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
