import { readFileSync } from 'node:fs';
import { buyingChange } from '../../src/lib/suggestions';
const orders = JSON.parse(readFileSync(process.env.FILE ?? 'spike/db/combined.json', 'utf8'));
const out: string[] = [];
for (let t = Date.parse('2026-02-01'); t <= Date.parse('2026-09-19'); t += 7 * 86400000) { const d = new Date(t).toISOString().slice(0, 10); const s = buyingChange(orders, [], d, 'Asia/Kolkata'); out.push(d + ' ' + (s && s.kind === 'buying_changed' ? s.direction + ' ' + s.ratio + ' since ' + s.since : '-')); }
console.log(out.join('\n'));
