// Scratch: the Insights page's numbers for an export.
import { readFileSync } from 'node:fs';
import { buildInsights } from '../../src/lib/insights';
const orders = JSON.parse(readFileSync(process.env.FILE ?? 'spike/db/combined.json', 'utf8'));
const last = Math.max(...orders.map((o: { placedAt: string }) => +new Date(o.placedAt)));
const i = buildInsights(orders, [{ vendor: 'instamart', coverageStart: new Date(last - 365 * 86400000).toISOString() }], new Date(last + 3600000), 'Asia/Kolkata');
console.log(JSON.stringify(i, null, 1));
