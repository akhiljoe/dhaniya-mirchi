// Phase 0 spike — run the real engine on real Blinkit history.
//
// Maps orders.json through mapping.json → canonical purchase events → the
// engine (src/engine) → predictions. Prints what the product would actually say.
//
//   npm run analyze
//
import { existsSync, readFileSync } from 'node:fs';
import {
  analyzeAll,
  categoryDefaults,
  coverageGaps,
  toCanonical,
  formatQty,
  type AwayPeriod,
  type HistoryGap,
  type ItemInput,
  type Prediction,
  type Unit,
} from '../../src/engine/index.ts';

interface RawItem { name: string; pack: number | null; unit: string; count: number }
interface Order { orderId: string; placedAt: string | null; status: string; items: RawItem[] }
interface Mapping { raw: string; canonical: string; category: string; baseUnit: Unit }

function main() {
  const orders: Order[] = JSON.parse(readFileSync('orders.json', 'utf8'));
  const mapRows: Mapping[] = JSON.parse(readFileSync('mapping.json', 'utf8'));
  const map = new Map(mapRows.map((m) => [m.raw, m]));

  // Build canonical purchases per item from delivered orders.
  const byItem = new Map<string, ItemInput>();
  let mapped = 0;
  let skipped = 0;
  // Lines with no honest conversion into the item's base unit (pack unknown,
  // or a different dimension — e.g. coriander by the bunch vs by the gram).
  // Skipped, never guessed; listed so the pack can be learned (design §8).
  const unconvertible = new Map<string, Record<string, number>>();
  for (const o of orders) {
    if (o.status && o.status !== 'DELIVERED') continue;
    if (!o.placedAt) continue;
    const at = new Date(o.placedAt);
    for (const it of o.items) {
      const m = map.get(it.name);
      if (!m || m.category === 'exclude') {
        skipped++;
        continue;
      }
      const packQty = it.pack === null ? null : toCanonical(it.pack, it.unit, m.baseUnit);
      if (packQty === null) {
        const row = unconvertible.get(m.canonical) ?? {};
        const k = it.pack === null ? 'pack unknown' : `${it.unit}→${m.baseUnit}`;
        row[k] = (row[k] ?? 0) + 1;
        unconvertible.set(m.canonical, row);
        skipped++;
        continue;
      }
      const qty = packQty * (it.count || 1);
      if (qty <= 0) {
        skipped++;
        continue;
      }
      let entry = byItem.get(m.canonical);
      if (!entry) {
        // Perishability from the item's category (design §9.11) — only matters
        // once away periods exist.
        entry = { itemId: m.canonical, unit: m.baseUnit, purchases: [], ...categoryDefaults(m.category) };
        byItem.set(m.canonical, entry);
      }
      entry.purchases.push({ at, qty });
      mapped++;
    }
  }

  // Coverage gaps (design §9.10) from merge.ts's coverage.json, if present.
  // NO_COVERAGE=1 disables them, to compare against the old behaviour.
  let gaps: HistoryGap[] = [];
  if (existsSync('coverage.json') && process.env.NO_COVERAGE !== '1') {
    const cov: { source: string; coverageStart: string | null }[] = JSON.parse(readFileSync('coverage.json', 'utf8'));
    gaps = coverageGaps(cov.map((c) => ({ source: c.source, coverageStart: c.coverageStart ? new Date(c.coverageStart) : null })));
  }

  // Household away periods (design §9.11) from an optional away.json:
  //   [{ "from": "2026-05-01", "to": "2026-05-12" }, ...]   ("to": null = ongoing)
  let away: AwayPeriod[] = [];
  if (existsSync('away.json')) {
    const raw: { from: string; to: string | null }[] = JSON.parse(readFileSync('away.json', 'utf8'));
    away = raw.map((a) => ({ from: new Date(a.from), to: a.to ? new Date(a.to) : null }));
  }

  const now = new Date(); // "now" = today; history runs up to the last order
  const preds = analyzeAll([...byItem.values()], now, { gaps, away }).sort((a, b) => b.purchaseCount - a.purchaseCount);

  console.log(`mapped ${mapped} line items into ${byItem.size} canonical items (skipped ${skipped} excluded/zero/unconvertible)`);
  const dropped = preds.reduce((n, p) => n + p.droppedForGaps, 0);
  const lostRate = preds.filter((p) => p.droppedForGaps > 0 && p.dailyRate === null).length;
  console.log(
    gaps.length
      ? `coverage gaps: ${gaps.map((g) => `${g.from?.toISOString().slice(0, 10) ?? 'start'} → ${g.to.toISOString().slice(0, 10)}`).join(', ')}` +
          ` — ${dropped} intervals dropped; ${lostRate} items now have no rate (history only inside the gap)\n`
      : 'coverage gaps: none\n',
  );
  if (away.length) {
    const shortened = preds.reduce((n, p) => n + p.shortenedForAway, 0);
    const droppedAway = preds.reduce((n, p) => n + p.droppedForAway, 0);
    console.log(`away periods: ${away.length} — ${shortened} intervals shortened, ${droppedAway} dropped (perishable / no home days)\n`);
  }

  const unconv = [...unconvertible.entries()]
    .map(([item, row]) => ({ item, row, n: Object.values(row).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.n - a.n);
  if (unconv.length) {
    const total = unconv.reduce((a, u) => a + u.n, 0);
    console.log(`=== ${total} lines skipped: no honest unit conversion (packs to learn) ===`);
    for (const u of unconv.slice(0, 20)) {
      console.log(`  ${String(u.n).padStart(4)}  ${u.item.padEnd(24)} ${Object.entries(u.row).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    }
    console.log('');
  }

  // Focus on items with enough history to predict.
  const predictable = preds.filter((p) => p.purchaseCount >= 3);
  console.log(`=== items with >=3 purchases (${predictable.length}) — real predictions ===\n`);
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(pad('item', 20) + pad('buys', 6) + pad('every', 9) + pad('rate/day', 14) + pad('conf', 8) + pad('left', 12) + pad('days', 10) + 'status');
  console.log('-'.repeat(96));
  for (const p of predictable) {
    line(p, pad);
  }

  // Status summary — what the shopping list would show today.
  const buckets: Record<string, string[]> = { LIKELY_OUT: [], BUY_SOON: [], RUNNING_LOW: [], AVAILABLE: [], UNKNOWN: [] };
  for (const p of predictable) buckets[p.status].push(p.itemId);
  console.log('\n=== shopping list today ===');
  for (const s of ['LIKELY_OUT', 'BUY_SOON', 'RUNNING_LOW'] as const) {
    if (buckets[s].length) console.log(`\n${s}:\n  ${buckets[s].join(', ')}`);
  }
}

function line(p: Prediction, pad: (s: string, n: number) => string) {
  const every = p.avgIntervalDays ? `${p.avgIntervalDays.toFixed(1)}d` : '-';
  const rate = p.dailyRate ? `${formatQty(p.dailyRate, p.unit)}` : '-';
  const left = p.qtyRemaining != null ? formatQty(p.qtyRemaining, p.unit) : '-';
  const dr =
    p.daysRemainingLow != null && p.daysRemainingHigh != null
      ? `${p.daysRemainingLow.toFixed(0)}-${p.daysRemainingHigh.toFixed(0)}`
      : '-';
  console.log(
    pad(p.itemId, 20) + pad(String(p.purchaseCount), 6) + pad(every, 9) + pad(rate, 14) + pad(p.confidence, 8) + pad(left, 12) + pad(dr, 10) + p.status,
  );
}

main();
