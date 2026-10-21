// Merge every vendor's extracted history into one purchase stream.
//
// Reads each spike's lean orders.json (same shape across vendors), keeps only
// DELIVERED orders with a known placedAt, and writes here:
//   orders.json             — merged, newest first, `source` on every order
//   coverage.json           — per source, the oldest order it served (§9.10)
//   distinct_products.json  — names only, for ../blinkit/normalize.ts
//
// Then normalize + analyze run unchanged against this directory:
//
//   npx tsx merge.ts
//   npx tsx ../blinkit/normalize.ts
//   npx tsx ../blinkit/analyze.ts
//
// Dedup is by (source, orderId). Cross-vendor duplicates are not merged away:
// the same milk bought on two apps is two purchases.
//
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface LineItem {
  name: string;
  pack: number | null;
  unit: string;
  count: number;
  pricePaid: number | null;
}

interface Order {
  orderId: string;
  placedAt: string | null;
  status: string;
  total: number | null;
  address: string | null;
  source: string;
  items: LineItem[];
}

const SOURCES = ['../blinkit/orders.json', '../instamart/orders.json'];

function main() {
  const byKey = new Map<string, Order>();
  // Per source: the oldest order it served at all (any status). A vendor that
  // keeps a rolling window (Instamart: 12 months) can't show anything older, so
  // this is where its visible history begins (design §9.10). Written to
  // coverage.json for analyze → the engine's coverage gaps.
  const coverage: { source: string; coverageStart: string | null }[] = [];
  for (const file of SOURCES) {
    if (!existsSync(file)) {
      console.log(`[skip] ${file} not found`);
      continue;
    }
    const orders: Order[] = JSON.parse(readFileSync(file, 'utf8'));
    const dated = orders.map((o) => o.placedAt).filter((d): d is string => !!d).sort();
    if (orders.length) coverage.push({ source: orders[0].source, coverageStart: dated[0] ?? null });
    let kept = 0;
    let notDelivered = 0;
    let undated = 0;
    for (const o of orders) {
      if (o.status !== 'DELIVERED') {
        notDelivered++;
        continue;
      }
      if (!o.placedAt) {
        undated++; // an undated purchase cannot be placed on the timeline
        continue;
      }
      byKey.set(`${o.source}:${o.orderId}`, {
        orderId: o.orderId,
        placedAt: o.placedAt,
        status: o.status,
        total: o.total,
        address: o.address,
        source: o.source,
        items: o.items.map((it) => ({
          name: it.name,
          pack: it.pack,
          unit: it.unit,
          count: it.count,
          pricePaid: it.pricePaid,
        })),
      });
      kept++;
    }
    const src = orders[0]?.source ?? file;
    console.log(`${src.padEnd(10)} ${String(kept).padStart(4)} delivered+dated  (skipped ${notDelivered} not delivered, ${undated} undated)`);
  }

  const merged = [...byKey.values()].sort((a, b) => b.placedAt!.localeCompare(a.placedAt!));
  writeFileSync('orders.json', JSON.stringify(merged, null, 2));
  writeFileSync('coverage.json', JSON.stringify(coverage, null, 2));
  console.log(`\ncoverage: ${coverage.map((c) => `${c.source} from ${c.coverageStart?.slice(0, 10) ?? 'all'}`).join(', ')}`);

  // Names-only distinct list for normalization — no prices, dates, or address.
  const distinct = new Map<string, { name: string; count: number; units: Record<string, number> }>();
  for (const o of merged) {
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

  // Per-month order counts by source — shows where each vendor's history
  // starts and whether one app replaced the other over time.
  const months = new Map<string, Record<string, number>>();
  for (const o of merged) {
    const m = o.placedAt!.slice(0, 7);
    const row = months.get(m) ?? {};
    row[o.source] = (row[o.source] ?? 0) + 1;
    months.set(m, row);
  }
  const sources = [...new Set(merged.map((o) => o.source))];
  console.log(`\nmonth    ${sources.map((s) => s.padStart(10)).join('')}`);
  for (const [m, row] of [...months.entries()].sort()) {
    console.log(`${m}  ${sources.map((s) => String(row[s] ?? 0).padStart(10)).join('')}`);
  }

  const lines = merged.reduce((n, o) => n + o.items.length, 0);
  console.log(`\nmerged: ${merged.length} orders, ${lines} line items, ${distinctArr.length} distinct product strings`);
  console.log('wrote orders.json + distinct_products.json — next: npx tsx ../blinkit/normalize.ts');
}

main();
