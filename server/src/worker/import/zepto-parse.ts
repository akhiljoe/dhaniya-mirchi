// Zepto order history → what we keep (design §7.6, Appendix D). Built against
// the household's own recorded history (2026-09-24).
//
// Zepto splits an order in two:
//   - the LIST (`/api/v2/order/?page_number=N`) gives id, code, status, time
//     and total, and per line only a name and a count;
//   - the DETAIL (`ORDER_DETAILS`) gives each line's pack ("500 g",
//     "1 pack (500 ml)"), how many were ordered, fulfilled and rejected, and
//     what was paid - itself paged, until `endOfPage`.
// So an order is stored from its detail, and the list only says which orders
// exist and whether a detail is worth asking for.
//
// What survives parsing: order id, time, status, total, and per line the
// name, product variant, count fulfilled, price paid and pack label. What
// does NOT: the delivery address, the recipient, the phone, coordinates. The
// detail carries them in its info widgets, which are never read.
//
// Money is in paise on the wire (14900 = ₹149) and rupees here, as for the
// other vendors.
import { PROMO_ITEM_PATTERN, ZEPTO_DELIVERED_STATUSES, ZEPTO_PREPARED_BRANDS } from '../../constants.js';
import type { ParsedItem, ParsedOrder } from './instamart-parse.js';

const PAISE_PER_RUPEE = 100;

// One order as the list gives it: enough to decide whether to ask for its
// detail, and to store it without one when it never arrived.
export interface ZeptoStub {
  id: string;
  status: string; // already mapped (zeptoStatus)
  placedAt: string; // ISO
  total: number | null; // rupees
  // Zepto files older orders away; the detail call must say which it is.
  archived: boolean;
  // The list's own lines, name and count only. Used for an order that never
  // arrived, which needs no detail call: it is never shown or counted.
  lines: { name: string; count: number; variantId: string }[];
}

export interface ZeptoListPage {
  stubs: ZeptoStub[];
  endOfList: boolean;
}

// A line from the detail, with the pack the store sold it in.
export interface ZeptoLine {
  item: ParsedItem;
  packLabel: string | null;
}

// Zepto's status in the words the rest of the app reads. ARRIVED is a
// delivery (ZEPTO_DELIVERED_STATUSES); anything else is kept as Zepto says it:
// CANCELLED is dead, and whatever an order on its way is called shows as on
// its way until a later sync reads it delivered.
export function zeptoStatus(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (ZEPTO_DELIVERED_STATUSES.includes(s)) return 'DELIVERED';
  return s;
}

const rupees = (paise: unknown): number | null => (typeof paise === 'number' && Number.isFinite(paise) ? paise / PAISE_PER_RUPEE : null);

// A page of the order list, or null when it is not one (the caller decides
// whether that is a logout or a hiccup).
export function parseZeptoList(json: unknown): ZeptoListPage | null {
  const j = json as { orders?: unknown; endOfList?: unknown } | null;
  if (!j || !Array.isArray(j.orders)) return null;
  const stubs: ZeptoStub[] = [];
  for (const raw of j.orders) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const placed = typeof o.placedTime === 'string' ? new Date(o.placedTime) : null;
    // No id or no time: nothing to key it by or date it by, so not stored -
    // never dated by guesswork.
    if (!id || !placed || Number.isNaN(placed.getTime())) continue;
    const lines = (Array.isArray(o.productsNamesAndCounts) ? o.productsNamesAndCounts : [])
      .map((p) => (p ?? {}) as Record<string, unknown>)
      .filter((p) => typeof p.name === 'string' && typeof p.productVariantId === 'string')
      .map((p) => ({ name: String(p.name).trim(), count: typeof p.count === 'number' ? p.count : 1, variantId: String(p.productVariantId) }));
    stubs.push({ id, status: zeptoStatus(o.status), placedAt: placed.toISOString(), total: rupees(o.grandTotalAmount), archived: o.isArchived === true, lines });
  }
  return { stubs, endOfList: j.endOfList === true };
}

// The product lines anywhere in one page of an order's detail. They sit at
// widgets[].data.items[].orderProductsV2.sectionData[].orderProducts[], one
// section per group the page shows; every section is read, because a line's
// own fulfilled count - not the section it is filed under - says whether it
// arrived.
export function linesFromDetail(json: unknown): ZeptoLine[] {
  const out: ZeptoLine[] = [];
  const widgets = (json as { pageLayout?: { widgets?: unknown } } | null)?.pageLayout?.widgets;
  for (const w of Array.isArray(widgets) ? widgets : []) {
    const items = (w as { data?: { items?: unknown } })?.data?.items;
    for (const it of Array.isArray(items) ? items : []) {
      const sections = (it as { orderProductsV2?: { sectionData?: unknown } })?.orderProductsV2?.sectionData;
      for (const s of Array.isArray(sections) ? sections : []) {
        const products = (s as { orderProducts?: unknown })?.orderProducts;
        for (const p of Array.isArray(products) ? products : []) {
          const line = parseLine(p);
          if (line) out.push(line);
        }
      }
    }
  }
  return out;
}

function parseLine(raw: unknown): ZeptoLine | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const sp = (p.storeProduct ?? {}) as Record<string, unknown>;
  const product = (sp.product ?? {}) as Record<string, unknown>;
  const variant = (sp.productVariant ?? {}) as Record<string, unknown>;
  const name = typeof product.name === 'string' ? product.name.trim() : '';
  const variantId = typeof variant.id === 'string' ? variant.id : '';
  if (!name || !variantId || PROMO_ITEM_PATTERN.test(name)) return null;
  // What reached the door. A line the store could not supply is rejected,
  // and counting it would say the household bought what never came.
  const ordered = typeof p.quantityOrdered === 'number' ? p.quantityOrdered : null;
  const rejected = typeof p.quantityRejected === 'number' ? p.quantityRejected : 0;
  const count = typeof p.quantityFulfilled === 'number' ? p.quantityFulfilled : ordered !== null ? ordered - rejected : null;
  if (count === null || count <= 0) return null;
  const brand = typeof product.brand === 'string' ? product.brand.trim() : '';
  const prepared = ZEPTO_PREPARED_BRANDS.includes(brand) || (typeof p.unitRestaurantCharge === 'number' && p.unitRestaurantCharge > 0);
  const label = typeof variant.formattedPacksize === 'string' && variant.formattedPacksize.trim() ? variant.formattedPacksize.trim() : null;
  // The line's total is for what was ordered; a unit that never came was not
  // paid for, so the price follows the count that arrived.
  const total = rupees(p.totalFinalSellingPrice);
  const pricePaid = total !== null && ordered !== null && ordered > 0 && count !== ordered ? (total * count) / ordered : total;
  return {
    // The product variant is the pack: one id per size, the same at every
    // store, so it is the sku and the store is 0 (as on Blinkit).
    item: { name, sku: variantId, storeId: 0, count, pricePaid, ...(prepared ? { prepared: true as const } : {}) },
    packLabel: label,
  };
}

// Where the next page of an order's detail starts, or null at the end.
export function nextDetailParams(json: unknown): Record<string, unknown> | null {
  const j = (json ?? {}) as { endOfPage?: unknown; nextPageParams?: unknown };
  if (j.endOfPage === true) return null;
  const next = j.nextPageParams;
  return next && typeof next === 'object' ? (next as Record<string, unknown>) : null;
}

// One stored order from its list entry and its detail's lines. Lines of the
// same product are one line: Zepto files a product under one section, but
// nothing promises it never splits one across two.
export function zeptoOrder(stub: ZeptoStub, lines: ZeptoLine[]): { order: ParsedOrder; packs: Map<string, string> } {
  const bySku = new Map<string, ParsedItem>();
  const packs = new Map<string, string>();
  for (const l of lines) {
    const had = bySku.get(l.item.sku);
    if (had) {
      had.count += l.item.count;
      had.pricePaid = had.pricePaid !== null && l.item.pricePaid !== null ? had.pricePaid + l.item.pricePaid : null;
    } else bySku.set(l.item.sku, { ...l.item });
    if (l.packLabel) packs.set(l.item.sku, l.packLabel);
  }
  return {
    order: {
      vendorOrderId: stub.id,
      placedAt: stub.placedAt,
      status: stub.status,
      total: stub.total,
      addressLabel: null,
      addressRef: null,
      items: [...bySku.values()],
    },
    packs,
  };
}

// An order that never arrived, stored from the list alone: it is never shown
// or counted, so it is not worth a detail call. Its lines carry no price.
export function zeptoOrderFromList(stub: ZeptoStub): ParsedOrder {
  return {
    vendorOrderId: stub.id,
    placedAt: stub.placedAt,
    status: stub.status,
    total: stub.total,
    addressLabel: null,
    addressRef: null,
    items: stub.lines
      .filter((l) => !PROMO_ITEM_PATTERN.test(l.name))
      .map((l) => ({ name: l.name, sku: l.variantId, storeId: 0, count: l.count, pricePaid: null })),
  };
}
