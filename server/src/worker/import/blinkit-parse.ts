// Blinkit order history → what we keep (design §7.6, Appendix A). Ported from
// spike/blinkit/extract.ts, which pulled a real history with it.
//
// Blinkit answers in its app's own widget language: a list page is a bag of
// "snippets", and the parts we need are the ones tagged
// `order_history_container_vr` (the list) and `order_details_list` (an order's
// line items). Reading it is picking those out; everything else on the page is
// layout.
//
// What survives parsing: order id, time, status, total, and per line item the
// name, count, price paid and the pack the line was sold in. What does NOT:
// the delivery address text (kept only as a one-way reference, so orders can
// be grouped by address without the address being recoverable), the phone and
// the card digits.
//
// Two traps this file exists to hold:
//   - **The year.** The list's date text ("13 Sep, 9:58 pm") has no year, and
//     older orders carry none at all. The detail page's "placed on Sun, 13
//     Sep'26, 9:58 PM" does. The spike trusted the list and silently dropped
//     most of the orders (Appendix B), so an order with no detail date is
//     returned as null and simply not stored — never dated by guesswork.
//   - **No SKU.** A Blinkit line has no product id, only a name, while
//     `sku_packs` and everything downstream join on (vendor, store_id, sku).
//     The sku is therefore synthesised from the product name and the store id
//     is 0. Same name, same sku, every household — which is what makes a pack
//     size learned once useful to everyone (design §8: pack sizes are product
//     data, not personal).
import { createHash } from 'node:crypto';

import { ADDRESS_REF_CHARS, BLINKIT_SKU_CHARS, PROMO_ITEM_PATTERN } from '../../constants.js';
import type { ParsedItem, ParsedOrder } from './instamart-parse.js';

// Indian time: Blinkit shows it, and the parsed instant must not depend on
// the server's own timezone.
const IST_OFFSET = '+05:30';
// The same offset in milliseconds, for turning "today" into a date in the
// household's own zone rather than the worker's.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// One order as the list page describes it: enough to ask for its detail.
export interface BlinkitStub {
  orderId: string;
  cartId: string;
  status: string;
  total: number | null;
}

// A line item plus the pack the vendor sold it in. The pack is text on the
// line ("500 g x 1"), not a catalog lookup, so listing an order already
// teaches us its packs — `packLabel()` then costs no extra call.
export interface BlinkitLine {
  item: ParsedItem;
  packLabel: string | null;
}

// The pack belongs in the sku. Blinkit gives no product id, so the sku is
// made here - and a name alone is not the product: 40 of this household's
// 1,006 products are bought in more than one size (Milky Mist Paneer in 200 g
// and 500 g, Nandini Toned Milk in 500 ml and 1 L). Keyed by name alone they
// share one row in sku_packs, so every purchase of one size is counted as the
// other: 2.5x out on the paneer, 5x on the butter. The pack is part of what
// was bought, so it is part of the key (design §8).
export function blinkitSku(name: string, packLabel: string | null): string {
  return createHash('sha256')
    .update(`blinkit:item:${name.trim().toLowerCase()}|${packLabel ?? ''}`)
    .digest('hex')
    .slice(0, BLINKIT_SKU_CHARS);
}

export function addressRef(address: string): string {
  return createHash('sha256').update(`blinkit:address:${address.trim().toLowerCase()}`).digest('hex').slice(0, ADDRESS_REF_CHARS);
}

function firstRupee(s: string): number | null {
  const m = s.match(/₹\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function lastRupee(s: string): number | null {
  const m = [...s.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)];
  return m.length ? Number(m[m.length - 1][1].replace(/,/g, '')) : null;
}

// The quantity text comes in two orders, and getting them the wrong way round
// silently doubles or halves every prediction for that item:
//   pack-first : "500 g x 1", "1 kg x 1", "200g x 2"  → pack 500 g, count 1/2
//   count-first: "2 x 75 g", "3 x 1 L"                → count 2/3, pack 75 g/1 L
// The rule: the number touching a weight or volume unit is the PACK; whatever
// other number is present is the COUNT.
export function parseQty(text: string): { packLabel: string | null; count: number } {
  const s = text.trim();
  const unitM = s.match(/([\d.]+)\s*(ml|l|ltr|litre|kg|g|gm|gms)\b/i);
  if (unitM) {
    const pack = Number(unitM[1]);
    const unit = /^gms?$/i.test(unitM[2]) ? 'g' : unitM[2].toLowerCase();
    const label = `${pack} ${unit}`;
    // Which number is the count is decided by WHERE it sits, never by which
    // value differs from the pack: "2 x 2 kg" has both the same, and reading
    // it by value made that two-bag order look like one.
    const before = s.slice(0, unitM.index ?? 0);
    const after = s.slice((unitM.index ?? 0) + unitM[0].length);
    const countFirst = before.match(/([\d.]+)\s*[x×]\s*$/i);
    if (countFirst) return { packLabel: label, count: Number(countFirst[1]) };
    const packFirst = after.match(/^\s*[x×]\s*([\d.]+)/i);
    if (packFirst) return { packLabel: label, count: Number(packFirst[1]) };
    return { packLabel: label, count: 1 };
  }
  // No weight or volume: the store sells it by the piece. "1 x 6" is 6 of a
  // 1-piece pack; a bare "2" is 2 pieces.
  const m = s.match(/([\d.]+)\s*[x×]\s*([\d.]+)/i);
  if (m) return { packLabel: `${Number(m[1])} piece`, count: Number(m[2]) };
  const single = s.match(/([\d.]+)/);
  if (single) return { packLabel: `${Number(single[1])} piece`, count: 1 };
  return { packLabel: null, count: 1 };
}

// When the order was placed.
//
// Two wordings, and the difference matters. An older order says "placed on
// Sun, 13 Sep'26, 9:58 PM" and carries its year. An order from today says
// "placed today, 12:03 AM" and carries none - and until this read it, every
// order was invisible to the app on the day it was bought, which for a
// replenishment app is the day that matters most. The vendor reworded it to
// an absolute date a day or so later and the order appeared then.
//
// Resolving "today" is not the guess this file warns about elsewhere. That
// warning is about inferring a YEAR onto an absolute date like "13 Sep",
// which lost most of the orders (Appendix B). "Today" is resolvable exactly,
// because we know when we asked: `now` is passed in, never read from the
// clock here, so the same page always parses to the same instant in a test.
//
// IST throughout, as the rest of this file is: the vendor writes these in the
// household's own local time.
export function placedFromDetail(detail: unknown, now: Date = new Date()): string | null {
  const blob = JSON.stringify(detail ?? null);
  const rel = blob.match(/placed (today|yesterday),\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (rel) {
    const hour = (Number(rel[2]) % 12) + (/pm/i.test(rel[4]) ? 12 : 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    // The vendor's "today" is today where the household is, so the day is
    // taken in IST rather than in whatever zone the worker happens to run in.
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    if (/yesterday/i.test(rel[1])) ist.setUTCDate(ist.getUTCDate() - 1);
    const iso = `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(hour)}:${rel[3]}:00${IST_OFFSET}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = blob.match(
    /placed on [A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s*'\s*(\d{2}),\s*(\d{1,2}):(\d{2})\s*([AP]M)/i,
  );
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  const hour = (Number(m[4]) % 12) + (/pm/i.test(m[6]) ? 12 : 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `20${m[3]}-${pad(mon + 1)}-${pad(Number(m[1]))}T${pad(hour)}:${m[5]}:00${IST_OFFSET}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type Snippet = Record<string, unknown>;

function snippetsOf(json: unknown): Snippet[] {
  const list = (json as { response?: { snippets?: unknown } } | null)?.response?.snippets;
  return Array.isArray(list) ? (list as Snippet[]) : [];
}

function text(v: unknown): string {
  return typeof (v as { text?: unknown })?.text === 'string' ? ((v as { text: string }).text as string) : '';
}

export function stubsFromList(json: unknown): BlinkitStub[] {
  const out: BlinkitStub[] = [];
  for (const sn of snippetsOf(json)) {
    if (sn.widget_type !== 'order_history_container_vr') continue;
    const tracking = (sn.tracking ?? {}) as { common_attributes?: Record<string, unknown> };
    const attrs = tracking.common_attributes ?? {};
    const data = (sn.data ?? {}) as { identity?: { id?: unknown }; items?: unknown };
    const ids = String(data.identity?.id ?? '').match(/order_(\d+)_(\d+)/);
    const orderId = typeof attrs.order_id === 'string' ? attrs.order_id : (ids?.[1] ?? '');
    const cartId = ids?.[2] ?? '';
    if (!orderId || !cartId) continue;
    let total: number | null = null;
    for (const it of Array.isArray(data.items) ? data.items : []) {
      const d = ((it as { data?: unknown }).data ?? {}) as Record<string, unknown>;
      const line = text(d.left_underlined_subtitle);
      if (line) total = firstRupee(line) ?? total;
    }
    out.push({ orderId, cartId, status: typeof attrs.order_status === 'string' ? attrs.order_status : '', total });
  }
  return out;
}

// Blinkit ignores {offset, limit} — it answered the same ten orders for
// offset 0 and offset 10, and ten for limit 50 (probed 2026-09-20). The only
// way onwards is the page's own next_url plus the postback_params it hands
// back, so the cursor is that pair and nothing else.
export interface BlinkitCursor {
  url: string;
  body: Record<string, unknown>;
}

export function nextCursor(json: unknown): BlinkitCursor | null {
  const j = json as { response?: { pagination?: { next_url?: unknown } }; postback_params?: unknown } | null;
  const next = j?.response?.pagination?.next_url;
  if (typeof next !== 'string' || !next) return null;
  const body = j?.postback_params;
  return { url: next, body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {} };
}

export function itemsFromDetail(detail: unknown): BlinkitLine[] {
  const out: BlinkitLine[] = [];
  for (const sn of snippetsOf(detail)) {
    if (sn.widget_type !== 'z_v3_image_text_snippet_type_30') continue;
    const tracking = (sn.tracking ?? {}) as { widget_meta?: { widget_name?: unknown } };
    if (tracking.widget_meta?.widget_name !== 'order_details_list') continue;
    const d = (sn.data ?? {}) as Record<string, unknown>;
    const name = text(d.title).trim();
    if (!name) continue;
    if (PROMO_ITEM_PATTERN.test(name)) continue; // a free sample was not bought
    const { packLabel, count } = parseQty(text(d.subtitle1));
    out.push({
      item: { name, sku: blinkitSku(name, packLabel), storeId: 0, count, pricePaid: lastRupee(text(d.subtitle3)) },
      packLabel,
    });
  }
  return out;
}

// The delivery address, kept only as a one-way reference (design §7.6): enough
// to group orders by where they went, never enough to read the address back.
//
// An order page carries SEVERAL cards under `order_summary_details` - "Order
// details", the order id, the payment line, the address, the time - and the
// first of them is a heading. Hashing that (the first version of this did)
// gave every order the same reference: hundreds of orders, one value, a field that
// looked like an address grouping and said nothing. The address card is the
// one labelled "Deliver to", and only the text beside that label is hashed.
//
// Nothing else on that page is touched. It also holds "Paid via Card (XXXX
// XXXX 1111)", which is exactly the kind of thing §7.6 says never to keep.
const DELIVER_TO = /^deliver\s*to$/i;

export function addressRefFromDetail(detail: unknown): string | null {
  for (const sn of snippetsOf(detail)) {
    const tracking = (sn.tracking ?? {}) as { widget_meta?: { widget_name?: unknown } };
    if (tracking.widget_meta?.widget_name !== 'order_summary_details') continue;
    const texts: string[] = [];
    JSON.stringify(sn, (k, v) => {
      if (k === 'text' && typeof v === 'string' && v.trim()) texts.push(v.trim());
      return v;
    });
    if (!texts.some((t) => DELIVER_TO.test(t))) continue;
    const address = texts.filter((t) => !DELIVER_TO.test(t)).join(', ');
    if (address) return addressRef(address);
  }
  return null; // no address on the page: say so, rather than hash a heading
}

// An order is only worth storing once its detail page has given it a real
// date and its line items. No date → null, and the order is left for a later
// sync rather than stored on a guessed year.
export function parseBlinkitOrder(stub: BlinkitStub, detail: unknown, now: Date = new Date()): { order: ParsedOrder; packs: Map<string, string> } | null {
  const placedAt = placedFromDetail(detail, now);
  if (!placedAt) return null;
  const lines = itemsFromDetail(detail);
  const packs = new Map<string, string>();
  for (const l of lines) if (l.packLabel) packs.set(l.item.sku, l.packLabel);
  return {
    order: {
      vendorOrderId: stub.orderId,
      placedAt,
      status: stub.status,
      total: stub.total,
      addressLabel: null, // Blinkit's order page has no label for it, only the address
      addressRef: addressRefFromDetail(detail),
      items: lines.map((l) => l.item),
    },
    packs,
  };
}
