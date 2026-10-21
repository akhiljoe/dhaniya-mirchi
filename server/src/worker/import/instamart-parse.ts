// Instamart order history → what we keep (design §7.6, Appendix C). Ported
// from spike/instamart/extract.ts.
//
// What survives parsing: order id, time, status, total, and per line item the
// name, SKU, store, count and price paid. What does NOT: the delivery address
// text, flat number, the recipient's name and phone, coordinates. The only
// trace of the address is its label ("Home") and a one-way reference, enough
// to group orders by delivery address for the tracked-address filter (§7.9)
// without being able to recover the address.
import { createHash } from 'node:crypto';

import { ADDRESS_REF_CHARS, PROMO_ITEM_PATTERN } from '../../constants.js';

// The raw shape, as returned by /api/instamart/orders (only what we read).
export interface InstamartRawOrder {
  order_id: string;
  created_at: number; // epoch ms
  history_status: string;
  order_data?: { orders?: { order_jobs?: { metadata: string }[] }[] };
  order_data_v2?: { total?: { units?: number; nanos?: number } };
}

interface JobMeta {
  address?: { id?: string; annotation?: string };
  bill?: {
    billedItems?: {
      item: { itemId: string; storeId: number; quantity: number; name: string };
      bill?: { totalCost?: number };
    }[];
  };
}

export interface ParsedItem {
  name: string;
  sku: string;
  storeId: number;
  count: number;
  pricePaid: number | null;
  // The vendor marks it as food made to eat now (Zepto Cafe, Appendix D):
  // spending, never stock. Absent on every other line.
  prepared?: true;
}

export interface ParsedOrder {
  vendorOrderId: string;
  placedAt: string; // ISO
  status: string;
  total: number | null;
  addressLabel: string | null;
  addressRef: string | null;
  items: ParsedItem[];
}

export function addressRef(vendorAddressId: string): string {
  return createHash('sha256').update(`instamart:address:${vendorAddressId}`).digest('hex').slice(0, ADDRESS_REF_CHARS);
}

function jobsOf(o: InstamartRawOrder): JobMeta[] {
  const out: JobMeta[] = [];
  for (const sub of o.order_data?.orders ?? []) {
    for (const job of sub.order_jobs ?? []) {
      try {
        out.push(JSON.parse(job.metadata) as JobMeta);
      } catch {
        // a job whose metadata can't be read carries no items we can trust
      }
    }
  }
  return out;
}

export function parseInstamartOrder(o: InstamartRawOrder): ParsedOrder {
  const jobs = jobsOf(o);
  const address = jobs.find((j) => j.address)?.address;
  const items: ParsedItem[] = [];
  for (const job of jobs) {
    for (const b of job.bill?.billedItems ?? []) {
      if (PROMO_ITEM_PATTERN.test(b.item.name)) continue;
      items.push({
        name: b.item.name,
        sku: b.item.itemId,
        storeId: b.item.storeId,
        count: b.item.quantity,
        pricePaid: typeof b.bill?.totalCost === 'number' ? b.bill.totalCost : null,
      });
    }
  }
  const t = o.order_data_v2?.total;
  return {
    vendorOrderId: o.order_id,
    placedAt: new Date(o.created_at).toISOString(),
    status: o.history_status,
    total: t && typeof t.units === 'number' ? t.units + (t.nanos ?? 0) / 1e9 : null,
    addressLabel: address?.annotation || null,
    addressRef: address?.id ? addressRef(address.id) : null,
    items,
  };
}
