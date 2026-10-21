// Phase 0 spike — full extraction.
//
// Pulls the order history end to end and writes orders.json: real purchase data
// to feed the engine, and proof the whole ingestion path works. Runs inside the
// logged-in Chrome (the only client the edge allows).
//
//   npm run extract            # up to 40 most-recent orders (headful)
//   MAX_ORDERS=100 npm run extract
//   HEADLESS=1 npm run extract
//
// Lean shape — only the fields we actually need:
//   { orderId,            // dedup key
//     placedAt,           // ISO date+time — the field the engine runs on
//     status,             // DELIVERED etc; non-delivered must not count as a purchase
//     total,              // order total (₹)
//     address,            // delivery area (PII; spike-only, discarded in production)
//     source: 'blinkit',
//     items: [ { name, pack, unit, count, pricePaid } ] }
//
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { replayableHeaders, type CapturedSession } from './shared.ts';

const USER_DATA_DIR = './.userdata';
const MAX_ORDERS = Number(process.env.MAX_ORDERS ?? 40);
const DELAY_MS = Number(process.env.DELAY_MS ?? 900); // throttle to avoid 429
const DETAIL_TIMEOUT_MS = Number(process.env.DETAIL_TIMEOUT_MS ?? 30000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LineItem {
  name: string;
  pack: number | null;
  unit: string;
  count: number;
  pricePaid: number | null;
}
interface Order {
  orderId: string;
  cartId: string;
  placedAt: string | null;
  placedFromDetail?: boolean; // true = placedAt read from the detail page (has the year)
  placedText: string;
  status: string;
  total: number | null;
  address: string | null;
  source: 'blinkit';
  items: LineItem[];
}

function firstRupee(s: string): number | null {
  const m = s.match(/₹\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
function lastRupee(s: string): number | null {
  const m = [...s.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)];
  return m.length ? Number(m[m.length - 1][1].replace(/,/g, '')) : null;
}

// Quantity text comes in two orders:
//   pack-first : "500 g x 1", "1 kg x 1", "200g x 2"   → pack=500g, count=1/2
//   count-first: "2 x 75 g", "3 x 1 L"                 → count=2/3, pack=75g/1L
// Rule: the number adjacent to a weight/volume unit is the PACK; the other is
// the COUNT. Falls back to pack-first when no unit is present.
function parseQty(t: string): { pack: number | null; unit: string; count: number } {
  const s = t.trim();
  const unitM = s.match(/([\d.]+)\s*(ml|l|kg|g|gm)\b/i);
  if (unitM) {
    const pack = Number(unitM[1]);
    const unit = unitM[2].toLowerCase() === 'gm' ? 'g' : unitM[2].toLowerCase();
    // count = the other number in the string (the one that isn't the pack)
    const nums = [...s.matchAll(/([\d.]+)/g)].map((m) => Number(m[1]));
    const other = nums.find((n) => n !== pack);
    return { pack, unit, count: other ?? 1 };
  }
  // No weight/volume unit → treat as pieces. "12 x 1" / "1 x 6": take the count
  // as the number next to x, pack as pieces-per-unit when present.
  const m = s.match(/([\d.]+)\s*[x×]\s*([\d.]+)/i);
  if (m) return { pack: Number(m[1]), unit: 'piece', count: Number(m[2]) };
  const single = s.match(/([\d.]+)/);
  return { pack: single ? Number(single[1]) : null, unit: 'piece', count: 1 };
}

// "13 Sep, 9:58 pm" → ISO (most recent past occurrence)
function parsePlaced(t: string): string | null {
  const m = t.match(/(\d{1,2})\s+([A-Za-z]{3,})[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return null;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  let hr = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) hr += 12;
  const now = new Date();
  let d = new Date(now.getFullYear(), mon, Number(m[1]), hr, Number(m[4]));
  if (d.getTime() > now.getTime() + 86400000) d = new Date(now.getFullYear() - 1, mon, Number(m[1]), hr, Number(m[4]));
  return d.toISOString();
}

async function inBrowserPost(page: Page, url: string, headers: Record<string, string>, body: string) {
  return page.evaluate(
    async ([u, b, h]) => {
      const r = await fetch(u, { method: 'POST', credentials: 'include', headers: h as Record<string, string>, body: b as string });
      return { status: r.status, text: await r.text() };
    },
    [url, body, headers] as const,
  );
}

function stubsFromList(list: any): Omit<Order, 'placedAt' | 'address' | 'items' | 'source'>[] {
  const out: Omit<Order, 'placedAt' | 'address' | 'items' | 'source'>[] = [];
  for (const sn of list?.response?.snippets ?? []) {
    if (sn?.widget_type !== 'order_history_container_vr') continue;
    const attrs = sn?.tracking?.common_attributes ?? {};
    const idm = String(sn?.data?.identity?.id ?? '').match(/order_(\d+)_(\d+)/);
    const orderId = attrs.order_id ?? idm?.[1] ?? '';
    const cartId = idm?.[2] ?? '';
    let placedText = '';
    let total: number | null = null;
    for (const it of sn?.data?.items ?? []) {
      const d = it?.data ?? {};
      if (d?.subtitle?.text && /\d{1,2}:\d{2}\s*[ap]m/i.test(d.subtitle.text)) placedText = d.subtitle.text;
      if (d?.left_underlined_subtitle?.text) total = firstRupee(d.left_underlined_subtitle.text) ?? total;
    }
    if (orderId && cartId) out.push({ orderId, cartId, placedText, total, status: attrs.order_status ?? '' });
  }
  return out;
}

function itemsFromDetail(detail: any): LineItem[] {
  const out: LineItem[] = [];
  for (const sn of detail?.response?.snippets ?? []) {
    if (sn?.widget_type !== 'z_v3_image_text_snippet_type_30') continue;
    if (sn?.tracking?.widget_meta?.widget_name !== 'order_details_list') continue;
    const d = sn?.data ?? {};
    const name = d?.title?.text?.trim();
    if (!name) continue;
    if (/\b(sample|trial|free gift|freebie)\b/i.test(name)) continue; // promo add-ons, not purchases
    const { pack, unit, count } = parseQty((d?.subtitle1?.text ?? '').trim());
    out.push({ name, pack, unit, count, pricePaid: lastRupee(d?.subtitle3?.text ?? '') });
  }
  return out;
}

// Order time from the detail page: "placed on Sun, 13 Sep'26, 9:58 PM". Unlike
// the list's "13 Sep, 9:58 pm" (no year, and absent entirely on older orders)
// this carries the year, so it is the authoritative placedAt. Blinkit shows
// Indian time; pinned to +05:30 so the result doesn't depend on this machine's
// timezone.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function placedFromDetail(detail: any): string | null {
  const m = JSON.stringify(detail).match(
    /placed on [A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s*'\s*(\d{2}),\s*(\d{1,2}):(\d{2})\s*([AP]M)/i,
  );
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  const hr = (Number(m[4]) % 12) + (/pm/i.test(m[6]) ? 12 : 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `20${m[3]}-${pad(mon + 1)}-${pad(Number(m[1]))}T${pad(hr)}:${m[5]}:00+05:30`;
  return new Date(iso).toISOString();
}

// Delivery address (PII, spike-only): the "order_summary_details" card's texts.
function addressFromDetail(detail: any): string | null {
  for (const sn of detail?.response?.snippets ?? []) {
    if (sn?.tracking?.widget_meta?.widget_name !== 'order_summary_details') continue;
    const texts: string[] = [];
    JSON.stringify(sn, (k, v) => {
      if (k === 'text' && typeof v === 'string' && v.trim() && v.trim() !== 'Deliver to') texts.push(v.trim());
      return v;
    });
    if (texts.length) return texts.join(', ');
  }
  return null;
}

type Stub = ReturnType<typeof stubsFromList>[number];
const abs = (u: string) => (u.startsWith('http') ? u : 'https://blinkit.com' + (u.startsWith('/') ? u : '/' + u));

// One detail fetch with retry — navigation + waiting for the order_details XHR.
async function fetchDetail(
  page: Page,
  stub: Stub,
): Promise<{ items: LineItem[]; address: string | null; placedAt: string | null } | null> {
  const url = `https://blinkit.com/account/orders/${stub.cartId}/${stub.orderId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [resp] = await Promise.all([
        page.waitForResponse(
          async (r) => {
            if (!/blinkit\.com/.test(r.url())) return false;
            const rt = r.request().resourceType();
            if (rt !== 'xhr' && rt !== 'fetch') return false;
            try {
              return (await r.text()).includes('order_details_list');
            } catch {
              return false;
            }
          },
          { timeout: DETAIL_TIMEOUT_MS },
        ),
        page.goto(url, { waitUntil: 'commit' }),
      ]);
      const detail = JSON.parse(await resp.text());
      return { items: itemsFromDetail(detail), address: addressFromDetail(detail), placedAt: placedFromDetail(detail) };
    } catch {
      await sleep(DELAY_MS * (attempt + 2)); // back off before retrying
    }
  }
  return null;
}

async function main() {
  const s: CapturedSession = JSON.parse(readFileSync('session.json', 'utf8'));
  const headers = replayableHeaders(s.orderHistory.requestHeaders);
  const headless = process.env.HEADLESS === '1';

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://blinkit.com/', { waitUntil: 'domcontentloaded' });

  // ---- 1. list stubs: cached in stubs.json so re-runs skip re-pagination ----
  let stubs: Stub[] = [];
  if (existsSync('stubs.json') && process.env.RELIST !== '1') {
    stubs = JSON.parse(readFileSync('stubs.json', 'utf8'));
    console.log(`loaded ${stubs.length} stubs from stubs.json (RELIST=1 to re-paginate)`);
  } else {
    const seen = new Set<string>();
    let nextUrl: string | null = s.orderHistory.url;
    let body = s.orderHistory.postData ?? JSON.stringify({ offset: 0, limit: 10 });
    for (let pageNo = 0; nextUrl && stubs.length < MAX_ORDERS && pageNo < 500; pageNo++) {
      const res: { status: number; text: string } = await inBrowserPost(page, abs(nextUrl), headers, body);
      if (res.status === 429) {
        console.warn(`list page ${pageNo} → 429, backing off 15s...`);
        await sleep(15000);
        pageNo--; // retry same page
        continue;
      }
      if (res.status !== 200) {
        console.warn(`list page ${pageNo} → HTTP ${res.status}, stopping`);
        break;
      }
      const j = JSON.parse(res.text);
      const pageStubs = stubsFromList(j).filter((o) => !seen.has(o.orderId));
      if (pageStubs.length === 0) break;
      for (const o of pageStubs) seen.add(o.orderId);
      stubs.push(...pageStubs);
      console.log(`list page ${pageNo}: +${pageStubs.length} (total ${stubs.length})`);
      nextUrl = j?.response?.pagination?.next_url ?? null;
      body = JSON.stringify(j?.postback_params ?? {});
      await sleep(DELAY_MS);
    }
    writeFileSync('stubs.json', JSON.stringify(stubs, null, 2));
  }
  const todo = stubs.slice(0, MAX_ORDERS);

  // ---- 2. resume: keep already-fetched orders, only fetch missing details ----
  const byId = new Map<string, Order>();
  if (existsSync('orders.json')) {
    for (const o of JSON.parse(readFileSync('orders.json', 'utf8')) as Order[]) byId.set(o.orderId, o);
  }
  // Re-fetch orders without items, and orders whose date didn't come from the
  // detail page (the list date has no year and is missing on older orders).
  const needed = todo.filter((st) => {
    const o = byId.get(st.orderId);
    return !o?.items.length || !o.placedFromDetail;
  });
  console.log(`\n${todo.length} orders; ${todo.length - needed.length} complete, fetching ${needed.length}...\n`);

  let done = 0;
  for (const stub of needed) {
    const got = await fetchDetail(page, stub);
    const prev = byId.get(stub.orderId);
    byId.set(stub.orderId, {
      ...stub,
      placedAt: got?.placedAt ?? prev?.placedAt ?? parsePlaced(stub.placedText),
      placedFromDetail: !!got?.placedAt,
      address: got?.address ?? prev?.address ?? null,
      source: 'blinkit',
      items: got?.items.length ? got.items : (prev?.items ?? []),
    });
    done++;
    const when = got ? (got.placedAt?.slice(0, 10) ?? 'NO DATE') : '';
    console.log(`[${done}/${needed.length}] ${stub.orderId} ${when}: ${got ? got.items.length + ' items' : 'FAILED'}`);
    if (done % 20 === 0) writeFileSync('orders.json', JSON.stringify([...byId.values()], null, 2)); // checkpoint
    await sleep(DELAY_MS);
  }
  await context.close();

  // Order by placedAt (nulls last) for a clean history file.
  const orders = [...byId.values()].sort((a, b) => (b.placedAt ?? '').localeCompare(a.placedAt ?? ''));
  writeFileSync('orders.json', JSON.stringify(orders, null, 2));

  // Names-only distinct list for normalization — no prices, dates, or address.
  const distinct = new Map<string, { name: string; count: number; units: Record<string, number> }>();
  for (const o of orders) {
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
  console.log(`distinct products: ${distinctArr.length} → distinct_products.json (names only, safe to share)`);

  const totalItems = orders.reduce((n, o) => n + o.items.length, 0);
  console.log(`\n=== done ===`);
  console.log(`orders: ${orders.length}  (with items: ${orders.filter((o) => o.items.length).length})`);
  console.log(`line items: ${totalItems}`);
  console.log(`statuses: ${JSON.stringify(orders.reduce((m: Record<string, number>, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {}))}`);
  console.log('saved orders.json (gitignored — real purchase data)');

  console.log('\nsample line items (name — qty, no prices/address):');
  for (const it of orders.flatMap((o) => o.items).slice(0, 12)) {
    console.log(`  ${it.name} — ${it.pack ?? ''}${it.unit} x ${it.count}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
