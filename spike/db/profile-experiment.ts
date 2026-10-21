// Does telling the engine who lives here help (design §9.12)? Replays the
// combined household's orders with and without the facts the user gave
// (2026-09-19): 2 people and 2 dogs, then 4 people from when the mother-in-law
// and brother-in-law came (about 3–4 months ago; the orders jump in August);
// the dogs eat 2 boiled eggs a day plus carrot, pumpkin, curd and coconut oil;
// two people have tea twice a day with about half a glass of milk each.
//
//   npx tsx --tsconfig tsconfig.app.json spike/db/profile-experiment.ts
import { readFileSync } from 'node:fs';

import { backtest } from '../../src/lib/backtest';
import type { ApiOrder, HouseholdProfile } from '../../src/lib/household';

const DAY = 86_400_000;
const HORIZON = Number(process.env.HORIZON ?? 4);
const orders = JSON.parse(readFileSync(process.env.FILE ?? 'spike/db/combined.json', 'utf8')) as ApiOrder[];
const last = Math.max(...orders.map((o) => new Date(o.placedAt).getTime()));
const coverage = [{ vendor: 'instamart', coverageStart: new Date(last - 365 * DAY).toISOString() }];
const to = new Date(last - HORIZON * DAY);
const from = new Date(to.getTime() - 90 * DAY);
const LONG_AGO = new Date('2020-01-01T00:00:00Z');
// A glass of milk is taken as 250 ml here; the app asks, never assumes.
const TEA_MILK_ML_PER_DAY = 2 * 2 * 125;

function profile(change: string | null, regular: boolean): HouseholdProfile {
  const sizes = change
    ? [
        { from: LONG_AGO, people: 2, pets: 2 },
        { from: new Date(`${change}T00:00:00+05:30`), people: 4, pets: 2 },
      ]
    : [];
  const since = change ? new Date(`${change}T00:00:00+05:30`) : LONG_AGO;
  const regularUse = regular
    ? [
        { item: 'eggs', from: LONG_AGO, to: null, perDay: 2 },
        { item: 'carrot', from: LONG_AGO, to: null, perDay: null },
        { item: 'pumpkin', from: LONG_AGO, to: null, perDay: null },
        { item: 'curd', from: LONG_AGO, to: null, perDay: null },
        { item: 'coconut oil', from: LONG_AGO, to: null, perDay: null },
        { item: 'milk', from: since, to: null, perDay: TEA_MILK_ML_PER_DAY },
      ]
    : [];
  return { sizes, regular: regularUse, away: [] };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`.padStart(4));
const run = (name: string, p: HouseholdProfile) => {
  const r = backtest(orders, coverage, 'Asia/Kolkata', from, to, { stepDays: 1, horizonDays: HORIZON, profile: p });
  console.log(`${name.padEnd(44)} ${r.flagsPerDay.toFixed(1).padStart(5)}/day  prec ${pct(r.precision)}  top3 ${pct(r.precisionAt3)}  recall ${pct(r.recall)}`);
  return r;
};

console.log(`${orders.length} orders, ${HORIZON}-day horizon, 90 days replayed`);
run('nothing told', profile(null, false));
for (const change of ['2026-05-25', '2026-06-15', '2026-08-03']) run(`4 people from ${change}`, profile(change, false));
run('regular use only', profile(null, true));
for (const change of ['2026-06-15', '2026-08-03']) run(`4 people from ${change} + regular use`, profile(change, true));
