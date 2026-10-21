// Reading Blinkit's order widgets (design Appendix A, §7.6). The shapes are
// the ones spike/blinkit/extract.ts pulled a real history out of.
import { describe, expect, it } from 'vitest';

import {
  addressRefFromDetail,
  blinkitSku,
  itemsFromDetail,
  nextCursor,
  parseBlinkitOrder,
  parseQty,
  placedFromDetail,
  stubsFromList,
} from '../src/worker/import/blinkit-parse.js';

const listSnippet = (orderId: string, cartId: string, status: string, total: string) => ({
  widget_type: 'order_history_container_vr',
  tracking: { common_attributes: { order_id: orderId, order_status: status } },
  data: {
    identity: { id: `order_${orderId}_${cartId}` },
    items: [{ data: { subtitle: { text: '13 Sep, 9:58 pm' }, left_underlined_subtitle: { text: `₹${total} paid` } } }],
  },
});

const itemSnippet = (name: string, qty: string, price: string) => ({
  widget_type: 'z_v3_image_text_snippet_type_30',
  tracking: { widget_meta: { widget_name: 'order_details_list' } },
  data: { title: { text: name }, subtitle1: { text: qty }, subtitle3: { text: price } },
});

const summaryCard = (texts: string[]) => ({
  widget_type: 'v2_restaurant_card_vr_type_4',
  tracking: { widget_meta: { widget_name: 'order_summary_details' } },
  data: { rows: texts.map((t) => ({ text: t })) },
});

const detail = (opts: { placed?: string; items?: unknown[]; address?: string[] }) => ({
  response: {
    snippets: [
      ...(opts.placed ? [{ widget_type: 'v2_image_text_snippet_type_30', data: { title: { text: opts.placed } } }] : []),
      ...(opts.items ?? []),
      ...(opts.address ? [summaryCard(opts.address)] : []),
    ],
  },
});

describe('parseQty', () => {
  // The first parser got multipacks backwards, which doubles or halves every
  // prediction for that item (design §8).
  it('reads pack-first text', () => {
    expect(parseQty('500 g x 1')).toEqual({ packLabel: '500 g', count: 1 });
    expect(parseQty('200g x 2')).toEqual({ packLabel: '200 g', count: 2 });
    expect(parseQty('1 kg x 1')).toEqual({ packLabel: '1 kg', count: 1 });
  });

  it('reads count-first text the other way round', () => {
    expect(parseQty('2 x 75 g')).toEqual({ packLabel: '75 g', count: 2 });
    expect(parseQty('3 x 1 L')).toEqual({ packLabel: '1 l', count: 3 });
  });

  it('treats text with no weight or volume as pieces', () => {
    expect(parseQty('1 x 6')).toEqual({ packLabel: '1 piece', count: 6 });
    expect(parseQty('2')).toEqual({ packLabel: '2 piece', count: 1 });
  });

  it('reads the count by where it sits, not by which number differs', () => {
    // "2 x 2 kg" has the same number twice: reading it by value made a
    // two-bag order look like one.
    expect(parseQty('2 x 2 kg')).toEqual({ packLabel: '2 kg', count: 2 });
    expect(parseQty('5 x 5 g')).toEqual({ packLabel: '5 g', count: 5 });
  });

  it('does not read a unit out of the middle of a word', () => {
    expect(parseQty('5 gel pens')).toEqual({ packLabel: '5 piece', count: 1 });
  });

  it('gives no pack rather than a guess when there is no number', () => {
    expect(parseQty('')).toEqual({ packLabel: null, count: 1 });
    expect(parseQty('combo')).toEqual({ packLabel: null, count: 1 });
  });
});

describe('placedFromDetail', () => {
  it('reads the year the list does not carry, in Indian time', () => {
    expect(placedFromDetail(detail({ placed: "placed on Sun, 13 Sep'26, 9:58 PM" }))).toBe('2026-09-13T16:28:00.000Z');
    expect(placedFromDetail(detail({ placed: "placed on Mon, 1 Jan'24, 12:05 AM" }))).toBe('2023-12-31T18:35:00.000Z');
  });

  it('gives null when no dated line is there', () => {
    expect(placedFromDetail(detail({ placed: 'delivered in 9 minutes' }))).toBeNull();
    expect(placedFromDetail(null)).toBeNull();
  });

  // The day's own orders. Until this was read, an order was invisible to the
  // app on the day it was bought - the vendor writes "placed today" and only
  // reworded it to an absolute date a day later. For a replenishment app that
  // is the day that matters most.
  describe('an order from today, which carries no year at all', () => {
    // Real wording, from the order paid for at 12:03 AM on 2026-09-23.
    const reading = (iso: string) => new Date(iso);

    it('resolves "today" against when we asked, not against a guess', () => {
      // Asked at 00:25 IST on the 23rd, so "today" is the 23rd.
      expect(placedFromDetail(detail({ placed: 'placed today, 12:03 AM' }), reading('2026-09-22T18:55:00.000Z'))).toBe('2026-09-22T18:33:00.000Z');
    });

    it('resolves "yesterday" too', () => {
      expect(placedFromDetail(detail({ placed: 'placed yesterday, 11:30 PM' }), reading('2026-09-22T18:55:00.000Z'))).toBe('2026-09-22T18:00:00.000Z');
    });

    it('takes the day in the household zone, not the worker one', () => {
      // 19:00 UTC is already the NEXT day in India (00:30 IST). A worker
      // reading UTC would file the order a day early, every night.
      expect(placedFromDetail(detail({ placed: 'placed today, 12:10 AM' }), reading('2026-09-22T19:00:00.000Z'))).toBe('2026-09-22T18:40:00.000Z');
    });

    it('still prefers an absolute date when the vendor gives one', () => {
      // Both wordings in one page: the dated one wins, and `now` is ignored.
      const both = detail({ placed: "placed on Sun, 13 Sep'26, 9:58 PM" });
      expect(placedFromDetail(both, reading('2026-09-22T18:55:00.000Z'))).toBe('2026-09-13T16:28:00.000Z');
    });
  });
});

describe('stubsFromList', () => {
  it('takes the order and cart ids, the status and the total', () => {
    const json = { response: { snippets: [listSnippet('1234567890', '9876543210', 'DELIVERED', '312')] } };
    expect(stubsFromList(json)).toEqual([{ orderId: '1234567890', cartId: '9876543210', status: 'DELIVERED', total: 312 }]);
  });

  it('ignores every other widget on the page', () => {
    const json = { response: { snippets: [{ widget_type: 'banner' }, listSnippet('1', '2', 'DELIVERED', '10')] } };
    expect(stubsFromList(json)).toHaveLength(1);
  });

  it('drops an order it cannot identify', () => {
    const json = { response: { snippets: [{ widget_type: 'order_history_container_vr', data: { identity: { id: 'nope' } } }] } };
    expect(stubsFromList(json)).toEqual([]);
  });
});

describe('nextCursor', () => {
  // Blinkit ignores {offset, limit} (probed 2026-09-20): the page's own
  // next_url and postback_params are the only way onwards.
  it('carries the next url and the postback params', () => {
    const json = { response: { pagination: { next_url: '/v1/layout/order_history?page=2' } }, postback_params: { token: 'abc' } };
    expect(nextCursor(json)).toEqual({ url: '/v1/layout/order_history?page=2', body: { token: 'abc' } });
  });

  it('ends the walk when the page offers no next url', () => {
    expect(nextCursor({ response: { pagination: {} }, postback_params: { token: 'abc' } })).toBeNull();
    expect(nextCursor({ response: {} })).toBeNull();
    expect(nextCursor(null)).toBeNull();
  });

  it('still pages when there are no postback params', () => {
    expect(nextCursor({ response: { pagination: { next_url: '/next' } } })).toEqual({ url: '/next', body: {} });
  });
});

describe('itemsFromDetail', () => {
  it('reads name, count, price and the pack off the line', () => {
    const d = detail({ items: [itemSnippet('Amul Taaza Toned Milk', '500 ml x 2', '₹27 MRP ₹54 item total')] });
    expect(itemsFromDetail(d)).toEqual([
      { item: { name: 'Amul Taaza Toned Milk', sku: blinkitSku('Amul Taaza Toned Milk', '500 ml'), storeId: 0, count: 2, pricePaid: 54 }, packLabel: '500 ml' },
    ]);
  });

  it('drops promo add-ons, which were not bought', () => {
    const d = detail({
      items: [itemSnippet('Sample - Nivea Soft', '15 ml x 1', '₹0'), itemSnippet('Tata Salt', '1 kg x 1', '₹28')],
    });
    expect(itemsFromDetail(d).map((l) => l.item.name)).toEqual(['Tata Salt']);
  });

  it('ignores snippets of the same type from other parts of the page', () => {
    const other = { widget_type: 'z_v3_image_text_snippet_type_30', tracking: { widget_meta: { widget_name: 'chat_support' } }, data: { title: { text: 'Need help?' } } };
    expect(itemsFromDetail(detail({ items: [other] }))).toEqual([]);
  });
});

describe('blinkitSku', () => {
  // No product id in Blinkit's data, so name AND pack are the key — the same
  // for every household, which is what makes a learned pack size shared.
  it('is stable and ignores case and spacing', () => {
    expect(blinkitSku('Tata Salt', '1 kg')).toBe(blinkitSku('  tata salt ', '1 kg'));
    expect(blinkitSku('Tata Salt', '1 kg')).not.toBe(blinkitSku('Tata Salt Lite', '1 kg'));
    expect(blinkitSku('Tata Salt', '1 kg')).toHaveLength(16);
  });

  // 40 of this household's 1,006 products are bought in more than one size.
  // Keyed by name alone they shared one pack row, so every 200 g of paneer
  // counted as 500 g.
  it('separates the sizes a product is sold in', () => {
    expect(blinkitSku('Milky Mist Paneer', '200 g')).not.toBe(blinkitSku('Milky Mist Paneer', '500 g'));
    expect(blinkitSku('Nandini Toned Milk', '500 ml')).not.toBe(blinkitSku('Nandini Toned Milk', '1 l'));
  });

  it('still keys a line whose pack could not be read', () => {
    expect(blinkitSku('Mystery Item', null)).toHaveLength(16);
    expect(blinkitSku('Mystery Item', null)).not.toBe(blinkitSku('Mystery Item', '1 kg'));
  });
});

describe('addressRefFromDetail', () => {
  // A real order page carries several cards under this name, and the first is
  // the heading "Order details". Hashing that gave all 562 of the household's
  // orders the same reference - a field that looked like an address grouping
  // and meant nothing.
  const realPage = (address: string) => ({
    response: {
      snippets: [
        summaryCard(['Order details']),
        summaryCard(['Order id']),
        summaryCard(['ORD89909661903', 'ORD89909661903']),
        summaryCard(['Payment', 'Paid via Card (XXXX XXXX 1111)']),
        summaryCard(['Deliver to', address]),
        summaryCard(['Order placed', "placed on Sun, 13 Sep'26, 9:58 PM"]),
      ],
    },
  });

  it('reads the card labelled "Deliver to", not the heading before it', () => {
    const a = addressRefFromDetail(realPage('Floor 2, House No.2, Maple, Bengaluru'));
    const b = addressRefFromDetail(realPage('9 MG Road, Bengaluru'));
    expect(a).toHaveLength(16);
    expect(a).not.toBe(b);
  });

  it('gives the same reference for the same address, and never the address itself', () => {
    const ref = addressRefFromDetail(realPage('Floor 2, House No.2, Maple, Bengaluru'));
    expect(addressRefFromDetail(realPage('Floor 2, House No.2, Maple, Bengaluru'))).toBe(ref);
    expect(ref).not.toContain('Maple');
    expect(ref).not.toContain('Bengaluru');
  });

  // The card digits are on the same page and must never be what we hash.
  it('ignores the payment card, whatever else is on the page', () => {
    const noAddress = {
      response: {
        snippets: [summaryCard(['Order details']), summaryCard(['Payment', 'Paid via Card (XXXX XXXX 1111)'])],
      },
    };
    expect(addressRefFromDetail(noAddress)).toBeNull();
  });

  it('is null when the page carries no address card', () => {
    expect(addressRefFromDetail(detail({ items: [] }))).toBeNull();
  });
});

describe('parseBlinkitOrder', () => {
  const stub = { orderId: '1234567890', cartId: '9876543210', status: 'DELIVERED', total: 312 };

  it('builds the order and the packs it taught us', () => {
    const d = detail({
      placed: "placed on Sun, 13 Sep'26, 9:58 PM",
      items: [itemSnippet('Amul Taaza Toned Milk', '500 ml x 2', '₹54'), itemSnippet('Tata Salt', '1 kg x 1', '₹28')],
      address: ['Deliver to', '12 Maple Block, Bengaluru'],
    });
    const parsed = parseBlinkitOrder(stub, d);
    expect(parsed).not.toBeNull();
    expect(parsed!.order.vendorOrderId).toBe('1234567890');
    expect(parsed!.order.placedAt).toBe('2026-09-13T16:28:00.000Z');
    expect(parsed!.order.status).toBe('DELIVERED');
    expect(parsed!.order.total).toBe(312);
    expect(parsed!.order.addressLabel).toBeNull();
    expect(parsed!.order.items.map((i) => i.count)).toEqual([2, 1]);
    expect(parsed!.packs.get(blinkitSku('Tata Salt', '1 kg'))).toBe('1 kg');
  });

  // Appendix B: trusting the list's undated text lost most of the orders.
  it('refuses an order whose detail page carries no date', () => {
    const d = detail({ items: [itemSnippet('Tata Salt', '1 kg x 1', '₹28')] });
    expect(parseBlinkitOrder(stub, d)).toBeNull();
  });

  it('keeps a dated order that has no line items rather than inventing them', () => {
    const parsed = parseBlinkitOrder(stub, detail({ placed: "placed on Sun, 13 Sep'26, 9:58 PM" }));
    expect(parsed!.order.items).toEqual([]);
    expect(parsed!.packs.size).toBe(0);
  });
});
