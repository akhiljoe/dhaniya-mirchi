// Phase 0 spike — structure dump (v2).
//
// The order_history list is a widget tree. This maps it: histogram of widget
// types, a redacted skeleton of each distinct type (so the order-card shape is
// visible), the pagination mechanism, and — by opening one order's detail page
// and intercepting its API — where the line items actually live.
//
//   npm run dump
//
import { writeFileSync, readFileSync } from 'node:fs';
import { chromium, type Response as PwResponse } from 'playwright';
import { replayableHeaders, type CapturedSession } from './shared.ts';

const USER_DATA_DIR = './.userdata';
const PII = /address|addr|phone|mobile|\blat\b|\blon\b|email|pincode|house|flat|floor|landmark|name$|customer/i;

function skeleton(v: unknown, key = '', depth = 0, maxDepth = 9): unknown {
  if (depth > maxDepth) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [skeleton(v[0], key, depth + 1, maxDepth), `×${v.length}`] : [];
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = skeleton(val, k, depth + 1, maxDepth);
    return out;
  }
  if (typeof v === 'string') {
    if (PII.test(key)) return 'str[REDACTED]';
    return v.length > 60 ? `str(${v.length})` : `"${v}"`;
  }
  return typeof v;
}

async function inBrowserFetch(page: import('playwright').Page, url: string, headers: Record<string, string>, body: string) {
  return page.evaluate(
    async ([u, b, h]) => {
      const r = await fetch(u, { method: 'POST', credentials: 'include', headers: h as Record<string, string>, body: b as string });
      return { status: r.status, text: await r.text() };
    },
    [url, body, headers] as const,
  );
}

async function main() {
  const s: CapturedSession = JSON.parse(readFileSync('session.json', 'utf8'));
  const headers = replayableHeaders(s.orderHistory.requestHeaders);
  const body = s.orderHistory.postData ?? JSON.stringify({ offset: 0, limit: 10 });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://blinkit.com/', { waitUntil: 'domcontentloaded' });

  // ---- 1. the list ----
  const listRes = await inBrowserFetch(page, s.orderHistory.url, headers, body);
  const list = JSON.parse(listRes.text);
  writeFileSync('orders_raw.json', JSON.stringify(list, null, 2));

  const snippets: any[] = list?.response?.snippets ?? [];
  const byType: Record<string, number> = {};
  for (const sn of snippets) byType[sn?.widget_type ?? '?'] = (byType[sn?.widget_type ?? '?'] ?? 0) + 1;

  console.log(`\n=== list: ${snippets.length} snippets ===`);
  console.log('widget_type histogram:', byType);
  console.log('pagination.next_url present:', !!list?.response?.pagination?.next_url);

  console.log('\n=== skeleton of each distinct widget_type ===');
  const seen = new Set<string>();
  for (const sn of snippets) {
    const t = sn?.widget_type ?? '?';
    if (seen.has(t) || /separator/.test(t)) continue;
    seen.add(t);
    console.log(`\n--- ${t} ---`);
    console.log(JSON.stringify(skeleton(sn), null, 1).slice(0, 3500));
  }

  // Order cards carry identity "order_{orderId}_{cartId}". The web detail path
  // is /account/orders/{cartId}/{orderId} (the deeplink is an app-scheme URL).
  const rawStr = JSON.stringify(list);
  const ids = [...rawStr.matchAll(/"id"\s*:\s*"order_([0-9]+)_([0-9]+)"/g)].map((m) => ({ orderId: m[1], cartId: m[2] }));
  const detailPaths = [...new Set(ids.map((o) => `/account/orders/${o.cartId}/${o.orderId}`))];
  console.log('\n=== order references found ===');
  console.log('orders on this page:', ids.length);
  console.log('detail paths (constructed):', detailPaths.slice(0, 5));

  // ---- 2. one order's detail (where line items should be) ----
  const detailApis: { url: string; text: string }[] = [];
  const onResp = async (res: PwResponse) => {
    const u = res.request().url();
    if (!u.includes('blinkit.com')) return;
    const rt = res.request().resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    const nameMatch = /order|crystal|bill|invoice|detail/i.test(u);
    try {
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const text = await res.text();
      // Keep name-matching endpoints, or any sizeable JSON during detail nav.
      if (nameMatch || text.length > 4000) detailApis.push({ url: u.split('?')[0], text });
    } catch {}
  };
  page.on('response', onResp);

  if (detailPaths.length) {
    console.log(`\n=== opening detail page ${detailPaths[0]} to catch its API ===`);
    await page.goto('https://blinkit.com' + detailPaths[0], { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
  } else {
    console.log('\n(no detail path found in the list — inspect orders_raw.json)');
  }
  page.off('response', onResp);
  await context.close();

  console.log('\n=== detail API calls captured ===');
  for (const d of detailApis) {
    let j: unknown;
    try { j = JSON.parse(d.text); } catch { continue; }
    console.log(`\n--- ${d.url}  (${d.text.length} bytes) ---`);
    // Save the biggest one as the likely line-item source.
    console.log(JSON.stringify(skeleton(j), null, 1).slice(0, 6000));
    writeFileSync('detail_raw.json', JSON.stringify(j, null, 2));
  }
  if (detailApis.length) console.log('\n(saved last detail response to detail_raw.json)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
