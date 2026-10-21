// Scratch: compare ways of choosing the "running low" list, on the same
// replay and the same scores as src/lib/backtest.ts (not shipped).
//
//   npx tsx --tsconfig tsconfig.app.json spike/db/experiment.ts [db|merged]
import { readFileSync } from 'node:fs';
import { classify } from '../../src/catalog/classify';
import { buildHousehold, type ApiOrder } from '../../src/lib/household';
import { mostLikelyFirst } from '../../src/lib/list';

const DAY = 86_400_000, H = 3_600_000;
const src = process.argv[2] ?? 'db';
const HORIZON = Number(process.env.HORIZON ?? 4), DAYS = Number(process.env.DAYS ?? 90);
let orders: ApiOrder[]; let coverage: { vendor: string; coverageStart: string | null }[];
if (src === 'db') {
  orders = JSON.parse(readFileSync('spike/db/orders.json', 'utf8'));
  const last = Math.max(...orders.map((o) => +new Date(o.placedAt)));
  coverage = [{ vendor: 'instamart', coverageStart: new Date(last - 365 * DAY).toISOString() }];
} else {
  const raw = JSON.parse(readFileSync('spike/merge/orders.json', 'utf8')) as any[];
  orders = raw.filter((o) => o.status === 'DELIVERED').map((o) => ({ vendor: o.source, orderId: o.orderId, placedAt: o.placedAt, total: o.total, addressLabel: null,
    items: o.items.map((i: any) => ({ name: i.name, count: i.count, pricePaid: i.pricePaid, packLabel: i.pack === null ? null : `${i.pack} ${i.unit}` })) }));
  coverage = JSON.parse(readFileSync('spike/merge/coverage.json', 'utf8')).map((c: any) => ({ vendor: c.source, coverageStart: c.coverageStart }));
}
orders.sort((a, b) => a.placedAt.localeCompare(b.placedAt));
const bought = orders.map((o) => ({ at: +new Date(o.placedAt), items: new Set(o.items.map((l) => classify(l.name, l.packLabel)).filter((c) => c.category !== 'exclude').map((c) => c.canonical)) }));
const lastAt = bought[bought.length - 1].at;
const to = lastAt - HORIZON * DAY, from = to - DAYS * DAY;

// A flagger: given the orders visible at t, the items to flag, most likely first.
type Flagger = (t: number) => string[];

const current: Flagger = (t) => {
  const vis = orders.filter((o) => +new Date(o.placedAt) < t);
  const h = buildHousehold(vis, coverage, new Date(t), 'Asia/Kolkata');
  return mostLikelyFirst(h.inventory.filter((i) => i.status === 'likely-low')).map((i) => i.id);
};

// Interval model: from the item's own trips (purchases closer than tripHours
// merged into one), P(bought within the horizon | not bought for s days),
// empirical and recency-weighted (Kaplan–Meier-style, the open interval
// counts as "survived to s"). Flag if P ≥ minP.
function hazard(opts: { tripHours: number; halfLife: number; minP: number; minTrips: number; prior: number; horizon?: number }): Flagger {
  return (t) => {
    const h = (opts.horizon ?? HORIZON);
    const trips = new Map<string, number[]>();
    for (const b of bought) {
      if (b.at >= t) break;
      for (const i of b.items) {
        const a = trips.get(i) ?? []; if (!trips.has(i)) trips.set(i, a);
        if (a.length && b.at - a[a.length - 1] < opts.tripHours * H) continue;
        a.push(b.at);
      }
    }
    const out: { i: string; p: number }[] = [];
    for (const [i, a] of trips) {
      if (a.length < opts.minTrips) continue;
      const s = (t - a[a.length - 1]) / DAY;
      let risk = 0, ev = 0;
      for (let k = 1; k < a.length; k++) {
        const iv = (a[k] - a[k - 1]) / DAY, w = Math.pow(2, -((t - a[k]) / DAY) / opts.halfLife);
        if (iv > s) { risk += w; if (iv <= s + h) ev += w; }
      }
      const p = (ev) / (risk + opts.prior);
      if (p >= opts.minP) out.push({ i, p });
    }
    return out.sort((x, y) => y.p - x.p).map((x) => x.i);
  };
}

function score(name: string, f: Flagger) {
  const within = (item: string, s: number, e: number) => bought.some((b) => b.at > s && b.at <= e && b.items.has(item));
  let flags = 0, hits = 0, top = 0, topHits = 0; const flagged: { t: number; s: Set<string> }[] = [];
  for (let t = from; t <= to; t += DAY) {
    const list = f(t); flagged.push({ t, s: new Set(list) });
    list.forEach((i, k) => { const hit = within(i, t, t + HORIZON * DAY); flags++; if (hit) hits++; if (k < 3) { top++; if (hit) topHits++; } });
  }
  let purchases = 0, caught = 0; const seen = new Map<string, number>();
  for (const b of bought) for (const i of b.items) { const n = seen.get(i) ?? 0; if (n >= 2 && b.at - HORIZON * DAY >= from && b.at <= to) { purchases++; if (flagged.some((x) => x.t >= b.at - HORIZON * DAY && x.t < b.at && x.s.has(i))) caught++; } seen.set(i, n + 1); }
  const pc = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
  console.log(`${name.padEnd(46)} ${(flags / flagged.length).toFixed(1).padStart(5)}/day  prec ${pc(hits / flags)}  top3 ${pc(topHits / top)}  recall ${pc(caught / purchases)}`);
}

console.log(`${src}: ${orders.length} orders, horizon ${HORIZON} d, ${DAYS} days replayed`);
score('current (engine stock + dormant 2x)', current);
for (const minP of [0.15, 0.2, 0.25, 0.3, 0.4]) score(`hazard trip12h hl60 p≥${minP}`, hazard({ tripHours: 12, halfLife: 60, minP, minTrips: 3, prior: 1 }));
if (process.env.TODAY) {
  const t = Date.now();
  const cur = current(t), hz = hazard({ tripHours: 12, halfLife: 60, minP: 0.25, minTrips: 3, prior: 1 })(t);
  console.log(`\ntoday, current (${cur.length}): ${cur.join(', ')}`);
  console.log(`today, interval model (${hz.length}): ${hz.join(', ')}`);
}
