// Backtest the app's "running low" flags on the real merged history.
//
//   npx tsx --tsconfig tsconfig.app.json spike/merge/backtest.ts      (from the repo root)
//
// DAYS (default 90): how far back from the last order to replay.
// HORIZON (default 4): a flag counts as right if the item was bought within
// this many days after it.
import { readFileSync } from 'node:fs';

import { backtest } from '../../src/lib/backtest';
import type { ApiOrder } from '../../src/lib/household';

const DAY = 86_400_000;
const days = Number(process.env.DAYS ?? 90);
const horizonDays = Number(process.env.HORIZON ?? 4);

const raw = JSON.parse(readFileSync('spike/merge/orders.json', 'utf8')) as {
  orderId: string; placedAt: string; status: string; total: number; source: string;
  items: { name: string; pack: number | null; unit: string; count: number; pricePaid: number | null }[];
}[];
const orders: ApiOrder[] = raw
  .filter((o) => o.status === 'DELIVERED')
  .map((o) => ({
    vendor: o.source,
    orderId: o.orderId,
    placedAt: o.placedAt,
    total: o.total,
    addressLabel: null,
    items: o.items.map((i) => ({ name: i.name, count: i.count, pricePaid: i.pricePaid, packLabel: i.pack === null ? null : `${i.pack} ${i.unit}` })),
  }));
const coverage = (JSON.parse(readFileSync('spike/merge/coverage.json', 'utf8')) as { source: string; coverageStart: string | null }[]).map((c) => ({
  vendor: c.source,
  coverageStart: c.coverageStart,
}));

const last = Math.max(...orders.map((o) => new Date(o.placedAt).getTime()));
const to = new Date(last - horizonDays * DAY);
const from = new Date(to.getTime() - days * DAY);
const started = Date.now();
const r = backtest(orders, coverage, 'Asia/Kolkata', from, to, { stepDays: 1, horizonDays });

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
console.log(`${orders.length} orders · replayed ${r.days} days (${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}) · horizon ${horizonDays} d · ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`flagged per day: ${r.flagsPerDay.toFixed(1)}   precision: ${pct(r.precision)} (${r.hits}/${r.flags})   top 3: ${pct(r.precisionAt3)}   recall: ${pct(r.recall)} (${r.caught}/${r.purchases})`);
console.log('\nmost wrong flags (item: wrong / flagged):');
for (const i of r.byItem.slice(0, 15)) console.log(`  ${i.item.padEnd(28)} ${i.misses} / ${i.flags}`);
