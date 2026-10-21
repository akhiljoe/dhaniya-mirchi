// The household's orders, for the prediction engine in the browser (design
// §7.6, §9). The browser classifies lines into items and does all quantity
// math; this route only reads.
//
//   GET /api/orders → { orders: [...], coverage: [...] }
//
// Delivered orders and orders still on their way (each with its status; only
// delivered ones are purchases — the browser keeps the others out of every
// prediction), newest first, each line with its catalog pack label
// (null = not looked up yet, or not in the catalog). Line items, dates,
// totals and the delivery address's LABEL only — never the address
// reference, a phone or a name (design §7.6). Household-scoped. `by` is the
// email of the member whose connection read the order: in a shared household
// the history says who bought what (design §19).
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { DEAD_ORDER_STATUSES, MS_PER_DAY, VENDOR_HISTORY_DAYS } from '../constants.js';
import { sendJson } from '../http.js';
import { requireHousehold } from './households.js';

interface OrderRow {
  status: string;
  vendor: string;
  vendor_order_id: string;
  placed_at: Date;
  total: string | null;
  address_label: string | null;
  by: string | null;
  by_name: string | null;
  items: { name: string; count: number; pricePaid: number | null; packLabel: string | null; prepared: boolean | null }[];
}

export async function handleOrders(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/orders' || req.method !== 'GET') return false;
  const { household } = await requireHousehold(deps, req);
  const { rows } = await deps.db.query<OrderRow>(
    // One copy per order: two members who connected the same grocery account
    // each hold one (orders are stored per connection).
    `with picked as (
       select distinct on (vendor, vendor_order_id) id, connection_id, vendor, vendor_order_id, placed_at, status, total, address_label, items
         from raw_orders
        where household_id = $1 and status <> all($2::text[])
        order by vendor, vendor_order_id, created_at
     )
     select r.vendor, r.vendor_order_id, r.placed_at, r.status, r.total, r.address_label, u.email as by, u.display_name as by_name,
            jsonb_agg(jsonb_build_object(
              'name', x.i->>'name',
              'count', (x.i->>'count')::numeric,
              'pricePaid', (x.i->>'pricePaid')::numeric,
              'packLabel', p.label,
              -- the vendor's mark for food made to eat now (Zepto Cafe); null elsewhere
              'prepared', (x.i->>'prepared')::boolean) order by x.n) as items
       from picked r
       left join vendor_connections c on c.id = r.connection_id
       left join users u on u.id = c.user_id
       cross join lateral jsonb_array_elements(r.items) with ordinality as x(i, n)
       left join sku_packs p
         on p.vendor = r.vendor and p.store_id = (x.i->>'storeId')::bigint and p.sku = x.i->>'sku'
      group by r.id, r.vendor, r.vendor_order_id, r.placed_at, r.status, r.total, r.address_label, u.email, u.display_name
      order by r.placed_at desc`,
    [household.id, DEAD_ORDER_STATUSES],
  );
  const vendors = await deps.db.query<{ vendor: string }>(
    'select distinct vendor from vendor_connections where household_id = $1 order by vendor',
    [household.id],
  );
  const now = Date.now();
  sendJson(res, 200, {
    orders: rows.map((r) => ({
      vendor: r.vendor,
      orderId: r.vendor_order_id,
      placedAt: r.placed_at.toISOString(),
      status: r.status,
      total: r.total === null ? null : Number(r.total),
      addressLabel: r.address_label,
      by: r.by,
      byName: r.by_name,
      items: r.items,
    })),
    coverage: vendors.rows.map(({ vendor }) => {
      const days = VENDOR_HISTORY_DAYS[vendor] ?? null;
      return { vendor, coverageStart: days === null ? null : new Date(now - days * MS_PER_DAY).toISOString() };
    }),
  });
  return true;
}
