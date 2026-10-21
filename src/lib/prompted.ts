// Purchases the app prompted (design §9.1, §9.2). When the app puts
// something in the household's cart and they buy it, that purchase is
// evidence we created: counting it in the buying rhythm would let the app
// confirm its own predictions for ever. So each add is matched to the first
// order of that item, on that app, in the days after it, and that purchase is
// marked prompted. The engine then keeps it out of the rate while still
// counting it as "last bought" (due.ts, estimate.ts).
//
// Matching is deliberately narrow: same app, same item, the first order after
// the add and within PROMPTED_MATCH_DAYS. One add marks at most one order, so
// a household that keeps buying milk by itself is not silently ignored.
import { classifyLine } from '@/catalog/classify';

import { api } from './api';
import { PROMPTED_MATCH_DAYS } from './constants';
import type { ApiOrder } from './household';

export interface PromptedAdd {
  item: string; // canonical item ("milk")
  vendor: string;
  product: string;
  quantity: number;
  addedAt: string; // ISO
}

export function fetchPromptedAdds(): Promise<{ adds: PromptedAdd[] }> {
  return api('GET', '/api/cart/prompted');
}

// The order lines that came from a suggestion, as `${orderId}|${item}` keys.
export function promptedPurchases(orders: ApiOrder[], adds: PromptedAdd[], matchDays = PROMPTED_MATCH_DAYS): Set<string> {
  const out = new Set<string>();
  const byTime = [...orders].sort((a, b) => a.placedAt.localeCompare(b.placedAt));
  for (const add of adds) {
    const from = Date.parse(add.addedAt);
    const until = from + matchDays * 86_400_000;
    for (const o of byTime) {
      const at = Date.parse(o.placedAt);
      if (at < from || at > until || o.vendor !== add.vendor) continue;
      const has = o.items.some((l) => classifyLine(l).canonical === add.item);
      const key = `${o.orderId}|${add.item}`;
      if (!has || out.has(key)) continue;
      out.add(key);
      break; // one add marks one purchase
    }
  }
  return out;
}
