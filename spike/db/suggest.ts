// Scratch: what the app would ask the household today, from the combined orders.
import { readFileSync } from 'node:fs';
import { suggestionsFor, buyingChange } from '../../src/lib/suggestions';
const orders = JSON.parse(readFileSync('spike/db/combined.json', 'utf8'));
for (const today of ['2026-08-10', '2026-08-24', '2026-09-07', '2026-09-19']) console.log(today, JSON.stringify(buyingChange(orders, [], today, 'Asia/Kolkata')));
console.log('now', JSON.stringify(suggestionsFor(orders, [], new Date('2026-09-19T10:00:00Z'), 'Asia/Kolkata')));
