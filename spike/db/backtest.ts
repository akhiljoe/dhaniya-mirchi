// Backtest the app's "running low" flags on the household's orders as the
// api serves them (exported from the local database to spike/db/orders.json).
//
//   npx tsx --tsconfig tsconfig.app.json spike/db/backtest.ts      (from the repo root)
//
// DAYS (default 90), HORIZON (default 4): as in spike/merge/backtest.ts.
// FILE: another export (spike/db/combined.json: every household's orders).
import { readFileSync } from 'node:fs';

import { backtest } from '../../src/lib/backtest';
import type { ApiOrder } from '../../src/lib/household';

const DAY = 86_400_000;
const INSTAMART_HISTORY_DAYS = 365;
const days = Number(process.env.DAYS ?? 90);
const horizonDays = Number(process.env.HORIZON ?? 4);

const orders = JSON.parse(readFileSync(process.env.FILE ?? 'spike/db/orders.json', 'utf8')) as ApiOrder[];
const last = Math.max(...orders.map((o) => new Date(o.placedAt).getTime()));
const coverage = [{ vendor: 'instamart', coverageStart: new Date(last - INSTAMART_HISTORY_DAYS * DAY).toISOString() }];
const to = new Date(last - horizonDays * DAY);
const from = new Date(to.getTime() - days * DAY);
const started = Date.now();
const r = backtest(orders, coverage, 'Asia/Kolkata', from, to, { stepDays: 1, horizonDays });

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
console.log(`${orders.length} orders · replayed ${r.days} days (${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}) · horizon ${horizonDays} d · ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`flagged per day: ${r.flagsPerDay.toFixed(1)}   precision: ${pct(r.precision)} (${r.hits}/${r.flags})   top 3: ${pct(r.precisionAt3)}   recall: ${pct(r.recall)} (${r.caught}/${r.purchases})`);
console.log('\nmost wrong flags (item: wrong / flagged):');
for (const i of r.byItem.slice(0, 15)) console.log(`  ${i.item.padEnd(28)} ${i.misses} / ${i.flags}`);
