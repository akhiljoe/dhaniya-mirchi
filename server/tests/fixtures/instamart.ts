// SYNTHETIC Instamart order-history data in the real response shape (design
// Appendix C) — every value is invented. The real extracts stay in spike/,
// gitignored. It deliberately carries the personal fields the real payload
// has (name, phone, flat number, coordinates) so tests can prove they're
// dropped at parse time.

export const FAKE_PHONE = '9123456780';
export const FAKE_FLAT = 'Flat 4B, Test Residency';
export const FAKE_NAME = 'Test Person';

function job(items: { id: string; store: number; qty: number; name: string; cost: number }[], address = true) {
  return {
    metadata: JSON.stringify({
      ...(address
        ? {
            address: {
              id: 'addr-777',
              annotation: 'Home',
              area: 'Testnagar',
              flatNo: FAKE_FLAT,
              name: FAKE_NAME,
              mobile: FAKE_PHONE,
              lat: 12.9,
              lng: 77.6,
              address: `${FAKE_FLAT}, 1st Main, Testnagar`,
            },
          }
        : {}),
      bill: {
        billedItems: items.map((i) => ({
          item: { itemId: i.id, storeId: i.store, quantity: i.qty, name: i.name },
          bill: { totalCost: i.cost },
        })),
      },
    }),
  };
}

export function fakeOrder(opts: {
  id: string;
  createdAt: number;
  status?: string;
  jobs?: { metadata: string }[];
  total?: { units: number; nanos?: number };
}) {
  return {
    order_id: opts.id,
    created_at: opts.createdAt,
    history_status: opts.status ?? 'DELIVERED',
    order_data: { orders: [{ order_jobs: opts.jobs ?? [job([{ id: 'SKU_MILK', store: 101, qty: 2, name: 'Amul Gold Full Cream Milk', cost: 68 }])] }] },
    order_data_v2: { total: opts.total ?? { units: 68, nanos: 0 } },
  };
}

export { job as fakeJob };
