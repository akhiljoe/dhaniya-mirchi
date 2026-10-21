// Scratch: product names that fall through the catalog rules, most bought first.
import { readFileSync } from 'node:fs';
import { classify } from '../../src/catalog/classify';
import { RULES } from '../../src/catalog/rules';
import type { ApiOrder } from '../../src/lib/household';
const orders = JSON.parse(readFileSync(process.argv[2] ?? 'spike/db/combined.json', 'utf8')) as ApiOrder[];
const known = new Set(RULES.map((r) => r[1]));
const miss = new Map<string, { n: number; ex: string }>();
for (const o of orders) for (const l of o.items) { const c = classify(l.name, l.packLabel); if (c.category === 'exclude' || known.has(c.canonical)) continue; const m = miss.get(c.canonical) ?? { n: 0, ex: l.name }; m.n++; miss.set(c.canonical, m); }
for (const [k, m] of [...miss].sort((a, b) => b[1].n - a[1].n).slice(0, Number(process.argv[3] ?? 60))) console.log(`${String(m.n).padStart(3)}  ${k.padEnd(30)} ${m.ex}`);
