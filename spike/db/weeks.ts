import { readFileSync } from 'node:fs';
import { classify } from '../../src/catalog/classify';
import { localDay } from '../../src/lib/facts';
const orders = JSON.parse(readFileSync('spike/db/combined.json', 'utf8')) as any[];
const wk = (d: string) => { const t = Date.parse(d + 'T00:00:00Z'); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 86400000).toISOString().slice(0, 10); };
const byItem = new Map<string, Map<string, Set<string>>>();
for (const o of orders) { const day = localDay(new Date(o.placedAt), 'Asia/Kolkata'); if (day < '2026-04-27') continue; for (const l of o.items) { const c = classify(l.name, l.packLabel); if (c.category === 'exclude') continue; const m = byItem.get(c.canonical) ?? new Map(); byItem.set(c.canonical, m); const w = wk(day); m.set(w, (m.get(w) ?? new Set()).add(day)); } }
const top = [...byItem].map(([k, m]) => [k, [...m.values()].reduce((n, s) => n + s.size, 0)] as const).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log(top.map((t) => t.join(':')).join(' '));
const weeks = [...new Set(orders.map((o) => wk(localDay(new Date(o.placedAt), 'Asia/Kolkata'))))].filter((w) => w >= '2026-04-27').sort();
for (const w of weeks) console.log(w, top.reduce((n, [k]) => n + (byItem.get(k)!.get(w)?.size ?? 0), 0));
