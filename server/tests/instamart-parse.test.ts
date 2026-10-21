// Parsing Instamart order history into what we keep (design §7.6: line items,
// quantities and dates only; the delivery address, phone and name are
// discarded at ingest). Ported from spike/instamart/extract.ts.
import { describe, expect, it } from 'vitest';

import { addressRef, parseInstamartOrder } from '../src/worker/import/instamart-parse.js';
import { FAKE_FLAT, FAKE_NAME, FAKE_PHONE, fakeJob, fakeOrder } from './fixtures/instamart.js';

const T = Date.UTC(2026, 8, 15, 7, 30); // 2026-09-15T07:30Z

describe('parseInstamartOrder', () => {
  it('keeps the order id, time, status, total and line items', () => {
    const o = parseInstamartOrder(
      fakeOrder({
        id: 'ORD1',
        createdAt: T,
        total: { units: 642, nanos: 500_000_000 },
        jobs: [
          fakeJob([
            { id: 'SKU_MILK', store: 101, qty: 2, name: 'Amul Gold Full Cream Milk', cost: 68 },
            { id: 'SKU_CURD', store: 101, qty: 1, name: 'Milky Mist Set Curd', cost: 136 },
          ]),
        ],
      }),
    );
    expect(o).toMatchObject({
      vendorOrderId: 'ORD1',
      placedAt: '2026-09-15T07:30:00.000Z',
      status: 'DELIVERED',
      total: 642.5,
      items: [
        { name: 'Amul Gold Full Cream Milk', sku: 'SKU_MILK', storeId: 101, count: 2, pricePaid: 68 },
        { name: 'Milky Mist Set Curd', sku: 'SKU_CURD', storeId: 101, count: 1, pricePaid: 136 },
      ],
    });
  });

  it('drops every personal field — no phone, flat number, name or coordinates survive', () => {
    const o = parseInstamartOrder(fakeOrder({ id: 'ORD1', createdAt: T }));
    const text = JSON.stringify(o);
    for (const secret of [FAKE_PHONE, FAKE_FLAT, FAKE_NAME, '12.9', '77.6', 'addr-777', '1st Main']) {
      expect(text).not.toContain(secret);
    }
  });

  it('keeps only the address label, plus a one-way reference for grouping orders by address', () => {
    const o = parseInstamartOrder(fakeOrder({ id: 'ORD1', createdAt: T }));
    expect(o.addressLabel).toBe('Home');
    expect(o.addressRef).toBe(addressRef('addr-777'));
    expect(o.addressRef).not.toContain('addr-777');
    // Same address → same reference; a different one → different.
    expect(addressRef('addr-777')).toBe(addressRef('addr-777'));
    expect(addressRef('addr-888')).not.toBe(addressRef('addr-777'));
  });

  it('skips promotional add-ons that are not purchases', () => {
    const o = parseInstamartOrder(
      fakeOrder({
        id: 'ORD1',
        createdAt: T,
        jobs: [
          fakeJob([
            { id: 'S1', store: 101, qty: 1, name: 'Sample - Nivea Soft Sachet', cost: 0 },
            { id: 'S2', store: 101, qty: 1, name: "Flyer - Sid's Farm", cost: 0 },
            { id: 'S3', store: 101, qty: 1, name: 'Free Gift Tote', cost: 0 },
            { id: 'SKU_MILK', store: 101, qty: 1, name: 'Amul Gold Full Cream Milk', cost: 34 },
          ]),
        ],
      }),
    );
    expect(o.items.map((i) => i.sku)).toEqual(['SKU_MILK']);
  });

  it('collects items across all jobs of a split order, and survives one unreadable job', () => {
    const o = parseInstamartOrder(
      fakeOrder({
        id: 'ORD1',
        createdAt: T,
        jobs: [
          fakeJob([{ id: 'A', store: 101, qty: 1, name: 'Tomato', cost: 20 }]),
          { metadata: '{not json' },
          fakeJob([{ id: 'B', store: 202, qty: 3, name: 'Onion', cost: 45 }], false),
        ],
      }),
    );
    expect(o.items.map((i) => [i.sku, i.storeId])).toEqual([
      ['A', 101],
      ['B', 202],
    ]);
  });

  it('keeps a non-delivered status as-is (filtering is a later step)', () => {
    expect(parseInstamartOrder(fakeOrder({ id: 'ORD1', createdAt: T, status: 'FAILED' })).status).toBe('FAILED');
  });

  it('has no address when the vendor sent none', () => {
    const o = parseInstamartOrder(fakeOrder({ id: 'ORD1', createdAt: T, jobs: [fakeJob([{ id: 'A', store: 1, qty: 1, name: 'Tomato', cost: 20 }], false)] }));
    expect(o.addressLabel).toBeNull();
    expect(o.addressRef).toBeNull();
  });
});
