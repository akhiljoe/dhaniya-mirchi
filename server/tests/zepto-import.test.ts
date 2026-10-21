// Reading Zepto's order history (design Appendix D): the parse of the list
// and of an order's detail, and the walk from one to the other over a faked
// page. Every value here is invented, in the shapes recorded from the real
// site on 2026-09-24; the recordings stay in spike/zepto/, gitignored.
import { describe, expect, it } from 'vitest';

import { classifyZeptoResponse, readHeaders, sessionCookies, ZeptoImportSession } from '../src/worker/adapters/zepto-import.js';
import { classifyZeptoAuth } from '../src/worker/adapters/zepto.js';
import { linesFromDetail, nextDetailParams, parseZeptoList, zeptoOrder, zeptoStatus } from '../src/worker/import/zepto-parse.js';

const listOrder = (id: string, status: string, lines: [string, number, string][], extra: Record<string, unknown> = {}) => ({
  id,
  code: `CODE${id}`,
  status,
  placedTime: '2026-06-28T07:33:31.895779071Z',
  grandTotalAmount: 47480,
  isArchived: false,
  productsNamesAndCounts: lines.map(([name, count, productVariantId]) => ({ name, count, productVariantId, id: `sp-${productVariantId}` })),
  ...extra,
});

const product = (
  name: string,
  variantId: string,
  pack: string | null,
  q: { ordered: number; fulfilled?: number; rejected?: number },
  totalPaise: number,
  kitchen: { brand?: string; restaurantCharge?: number } = {},
) => ({
  quantityOrdered: q.ordered,
  ...(q.fulfilled === undefined ? {} : { quantityFulfilled: q.fulfilled }),
  quantityRejected: q.rejected ?? 0,
  totalFinalSellingPrice: totalPaise,
  unitRestaurantCharge: kitchen.restaurantCharge ?? 0,
  storeProduct: {
    product: { name, brand: kitchen.brand ?? 'Nandini' },
    productVariant: { id: variantId, ...(pack === null ? {} : { formattedPacksize: pack }) },
  },
});

// The detail's own nesting: widgets → items → orderProductsV2 → sections →
// products, plus the bill and order-info widgets that carry the address.
const detail = (products: unknown[], next: { endOfPage: boolean; nextPageParams?: unknown } = { endOfPage: true }) => ({
  ...next,
  pageLayout: {
    widgets: [
      { widgetName: 'SHIPMENT_ONE_WEB', data: { items: [{ orderProductsV2: { sectionData: [{ sectionTitle: 'Other Items', orderProducts: products }] } }] } },
      { widgetName: 'ORDER_INFO_WEB', data: { items: [{ title: 'Deliver to: Flat 4B, Test Residency, 9123456780' }] } },
    ],
  },
});

describe('zeptoStatus', () => {
  it('reads ARRIVED as delivered: it is what a finished order is left saying', () => {
    expect(zeptoStatus('ARRIVED')).toBe('DELIVERED');
    expect(zeptoStatus('DELIVERED')).toBe('DELIVERED');
  });

  it('keeps every other word as Zepto says it', () => {
    expect(zeptoStatus('CANCELLED')).toBe('CANCELLED');
    expect(zeptoStatus('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
  });
});

describe('parseZeptoList', () => {
  it('reads each order and the end of the list', () => {
    const page = parseZeptoList({ orders: [listOrder('o1', 'DELIVERED', [['Tomato Local', 1, 'v-tomato']])], endOfList: true });
    expect(page).toEqual({
      endOfList: true,
      stubs: [
        {
          id: 'o1',
          status: 'DELIVERED',
          placedAt: '2026-06-28T07:33:31.895Z',
          total: 474.8,
          archived: false,
          lines: [{ name: 'Tomato Local', count: 1, variantId: 'v-tomato' }],
        },
      ],
    });
  });

  it('skips an order with no time rather than dating it by guesswork', () => {
    const page = parseZeptoList({ orders: [listOrder('o1', 'DELIVERED', [], { placedTime: null })], endOfList: false });
    expect(page?.stubs).toEqual([]);
  });

  it('is null for JSON that is not an order list', () => {
    expect(parseZeptoList({ errors: ['nope'] })).toBeNull();
  });
});

describe('linesFromDetail', () => {
  it('reads the pack, the count that arrived and the price, and nothing of the address', () => {
    const lines = linesFromDetail(detail([product('Nandini Toned Milk', 'v-milk', '1 pack (500 ml)', { ordered: 2, fulfilled: 2 }, 5400)]));
    expect(lines).toEqual([{ item: { name: 'Nandini Toned Milk', sku: 'v-milk', storeId: 0, count: 2, pricePaid: 54 }, packLabel: '1 pack (500 ml)' }]);
    expect(JSON.stringify(lines)).not.toMatch(/Flat 4B|9123456780/);
  });

  // Counting a unit the store could not supply says the household bought
  // what never came.
  it('counts only what was fulfilled, and prices it by what arrived', () => {
    const [line] = linesFromDetail(detail([product('Curd', 'v-curd', '400 g', { ordered: 3, fulfilled: 1, rejected: 2 }, 9000)]));
    expect(line!.item.count).toBe(1);
    expect(line!.item.pricePaid).toBe(30);
  });

  it('works the count out from ordered and rejected when fulfilled is absent', () => {
    const [line] = linesFromDetail(detail([product('Curd', 'v-curd', '400 g', { ordered: 3, rejected: 1 }, 9000)]));
    expect(line!.item.count).toBe(2);
  });

  it('drops a line nothing of which arrived, and promotional add-ons', () => {
    expect(
      linesFromDetail(
        detail([product('Curd', 'v-curd', '400 g', { ordered: 1, fulfilled: 0, rejected: 1 }, 3000), product('Sample - Face Wash', 'v-s', '5 ml', { ordered: 1, fulfilled: 1 }, 0)]),
      ),
    ).toEqual([]);
  });

  // "Chicken Puff" read by its name is chicken. Zepto says which lines are
  // its own kitchen's; that mark is carried, never guessed from the name.
  it("marks Zepto Cafe's food as made to eat now, by the brand or the restaurant charge", () => {
    const lines = linesFromDetail(
      detail([
        product('Chicken Puff', 'v-puff', '100 g', { ordered: 2, fulfilled: 2 }, 16590, { brand: 'Zepto Cafe', restaurantCharge: 395 }),
        product('Samosa - 2 Pieces', 'v-sam', '160 g', { ordered: 1, fulfilled: 1 }, 5900, { brand: 'Other Kitchen', restaurantCharge: 250 }),
        product('Chicken Breast', 'v-chk', '500 g', { ordered: 1, fulfilled: 1 }, 29900),
      ]),
    );
    expect(lines.map((l) => [l.item.name, l.item.prepared ?? false])).toEqual([
      ['Chicken Puff', true],
      ['Samosa - 2 Pieces', true],
      ['Chicken Breast', false],
    ]);
    // Absent, not false, on a grocery line: stored lines stay as they were.
    expect('prepared' in lines[2]!.item).toBe(false);
  });

  it('keeps a line with no pack, with the pack unknown rather than guessed', () => {
    const [line] = linesFromDetail(detail([product('Coriander', 'v-cor', null, { ordered: 1, fulfilled: 1 }, 1000)]));
    expect(line!.packLabel).toBeNull();
  });
});

describe('nextDetailParams', () => {
  it('follows nextPageParams until endOfPage', () => {
    expect(nextDetailParams({ endOfPage: false, nextPageParams: { last_widget_id: 5, page_number: 1 } })).toEqual({ last_widget_id: 5, page_number: 1 });
    // The last page still carries params; endOfPage is what ends it.
    expect(nextDetailParams({ endOfPage: true, nextPageParams: { last_widget_id: 9, page_number: 2 } })).toBeNull();
  });
});

describe('zeptoOrder', () => {
  it('makes one line of a product filed twice', () => {
    const stub = parseZeptoList({ orders: [listOrder('o1', 'DELIVERED', [])], endOfList: true })!.stubs[0]!;
    const { order, packs } = zeptoOrder(stub, [
      { item: { name: 'Milk', sku: 'v-milk', storeId: 0, count: 1, pricePaid: 27 }, packLabel: '500 ml' },
      { item: { name: 'Milk', sku: 'v-milk', storeId: 0, count: 2, pricePaid: 54 }, packLabel: '500 ml' },
    ]);
    expect(order.items).toEqual([{ name: 'Milk', sku: 'v-milk', storeId: 0, count: 3, pricePaid: 81 }]);
    expect(packs.get('v-milk')).toBe('500 ml');
    expect(order.addressLabel).toBeNull();
    expect(order.addressRef).toBeNull();
  });
});

describe('classifyZeptoResponse', () => {
  it('reads Zepto JSON as an answer', () => {
    expect(classifyZeptoResponse(200, JSON.stringify({ orders: [] })).kind).toBe('ok');
  });

  it('a 401 or 403 from Zepto is the session no longer accepted', () => {
    expect(classifyZeptoResponse(401, JSON.stringify({ message: 'Unauthorized' }))).toEqual({ kind: 'unauthorized' });
    expect(classifyZeptoResponse(403, JSON.stringify({}))).toEqual({ kind: 'unauthorized' });
  });

  // A logout costs the household an OTP, so nothing that is not Zepto's own
  // refusal may read as one - least of all our fetch failing at CORS, which
  // is what a read that suddenly needs the signature would look like.
  it('a failed fetch, a 5xx, a rate limit or an HTML page is retryable', () => {
    expect(classifyZeptoResponse(-1, '')).toEqual({ kind: 'unreachable' });
    expect(classifyZeptoResponse(503, JSON.stringify({}))).toEqual({ kind: 'unreachable' });
    expect(classifyZeptoResponse(429, '')).toEqual({ kind: 'unreachable' });
    expect(classifyZeptoResponse(403, '<html>blocked</html>')).toEqual({ kind: 'unreachable' });
    expect(classifyZeptoResponse(200, '<html>challenge</html>')).toEqual({ kind: 'unreachable' });
  });
});

describe('classifyZeptoAuth', () => {
  it('ok, rejected or unreachable by what answered', () => {
    expect(classifyZeptoAuth(200, JSON.stringify({ verificationType: 'otp_sms', data: { msg: 'OTP Sent.' } }))).toBe('ok');
    expect(classifyZeptoAuth(400, JSON.stringify({ message: 'Invalid OTP' }))).toBe('rejected');
    expect(classifyZeptoAuth(200, '<html>challenge</html>')).toBe('unreachable');
    expect(classifyZeptoAuth(0, '')).toBe('unreachable');
    expect(classifyZeptoAuth(502, JSON.stringify({}))).toBe('unreachable');
  });
});

describe('readHeaders', () => {
  it('sends the site build twice and asks for the cookie login, nothing else', () => {
    expect(readHeaders('16.31.8')).toEqual({ app_version: '16.31.8', appversion: '16.31.8', auth_from_cookie: 'true' });
  });
});

describe('sessionCookies', () => {
  const c = (name: string, domain = '.zepto.com') => ({ name, value: 'x', domain, path: '/' });
  it('keeps the login and the ids, never the household location or another site', () => {
    const kept = sessionCookies([
      c('accessToken'),
      c('refreshToken'),
      c('device_id', 'www.zepto.com'),
      c('latitude', 'www.zepto.com'),
      c('user_position', 'www.zepto.com'),
      c('serviceability', 'www.zepto.com'),
      c('_ga'),
      c('accessToken', '.notzepto.com'),
    ]);
    expect(kept.map((k) => `${k.name}@${k.domain}`)).toEqual(['accessToken@.zepto.com', 'refreshToken@.zepto.com', 'device_id@www.zepto.com']);
  });
});

describe('ZeptoImportSession.listPage', () => {
  type Answer = { status: number; body: string };
  const API = 'https://bff-gateway.zepto.com';

  // Stands in for the loaded page. The key is the url, plus the order and
  // page a detail call asked for.
  function sessionOver(answer: (key: string) => Answer | undefined, seen: string[], onReload?: () => void) {
    const page = {
      async evaluate(script: string) {
        const a = JSON.parse(script.match(/const a = (\{.*?\});/s)![1]!) as { url: string; body: string | null; headers: Record<string, string> };
        const b = a.body ? (JSON.parse(a.body) as { orderId?: string; page_number?: number }) : null;
        const key = b?.orderId ? `${a.url}#${b.orderId}#${b.page_number ?? 0}` : a.url;
        seen.push(key);
        expect(a.headers.auth_from_cookie).toBe('true');
        const r = answer(key);
        if (!r) throw new Error(`no fake answer for ${key}`);
        return r;
      },
    };
    const hb = { browser: null as never, close: async () => undefined };
    return new ZeptoImportSession(hb as never, page as never, () => '16.31.8', 0, async () => onReload?.());
  }

  const ok = (json: unknown): Answer => ({ status: 200, body: JSON.stringify(json) });
  const DETAIL = `${API}/pfs-postorder/api/v1/get-page/ORDER_DETAILS`;

  it('lists a page, reads each arrived order through every page of its detail, and skips the detail of a cancelled one', async () => {
    const seen: string[] = [];
    const session = sessionOver(
      (key) =>
        ({
          [`${API}/api/v2/order/?page_number=1`]: ok({
            orders: [listOrder('o1', 'ARRIVED', [['Milk', 2, 'v-milk']]), listOrder('o2', 'CANCELLED', [['Curd', 1, 'v-curd']])],
            endOfList: false,
          }),
          [`${DETAIL}#o1#0`]: ok(detail([product('Milk', 'v-milk', '1 pack (500 ml)', { ordered: 2, fulfilled: 2 }, 5400)], { endOfPage: false, nextPageParams: { last_widget_id: 7, page_number: 1 } })),
          [`${DETAIL}#o1#1`]: ok(detail([], { endOfPage: true })),
        })[key],
      seen,
    );

    const page = await session.listPage(null);
    expect(seen).toEqual([`${API}/api/v2/order/?page_number=1`, `${DETAIL}#o1#0`, `${DETAIL}#o1#1`]);
    expect(page.orders.map((o) => [o.vendorOrderId, o.status])).toEqual([
      ['o1', 'DELIVERED'],
      ['o2', 'CANCELLED'],
    ]);
    expect(page.orders[0]!.items).toEqual([{ name: 'Milk', sku: 'v-milk', storeId: 0, count: 2, pricePaid: 54 }]);
    expect(page.packs).toEqual([{ sku: 'v-milk', storeId: 0, label: '1 pack (500 ml)' }]);
    expect(page.nextCursor).toBe(2);
    // The pack came with the order: no call to learn it.
    expect(await session.packLabel('v-milk')).toBe('1 pack (500 ml)');
    expect(await session.packLabel('v-unknown')).toBeNull();
  });

  it('stops at the end of the list', async () => {
    const session = sessionOver((key) => (key.endsWith('page_number=12') ? ok({ orders: [], endOfList: true }) : undefined), []);
    const page = await session.listPage(12);
    expect(page.orders).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  // An hour-old access token is renewed by the site's own load, so the first
  // refusal reloads the page and asks again; only a second is a logout.
  it('reloads once on a refusal and carries on when the site has renewed its login', async () => {
    let reloads = 0;
    const session = sessionOver(
      () => (reloads === 0 ? { status: 401, body: JSON.stringify({ message: 'expired' }) } : ok({ orders: [], endOfList: true })),
      [],
      () => reloads++,
    );
    await expect(session.listPage(null)).resolves.toMatchObject({ orders: [] });
    expect(reloads).toBe(1);
  });

  it('is a logout when Zepto still refuses after the reload', async () => {
    let reloads = 0;
    const session = sessionOver(() => ({ status: 401, body: JSON.stringify({}) }), [], () => reloads++);
    await expect(session.listPage(null)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(reloads).toBe(1);
  });

  // Holes in a history are worse than no history (design §9.10): when no
  // detail on a page can be read, the shape has moved and the job stops.
  it('stops the job when no order on the page has a readable detail', async () => {
    const session = sessionOver(
      (key) =>
        key.includes('ORDER_DETAILS') ? ok({ pageLayout: { widgets: [] }, endOfPage: true }) : ok({ orders: [listOrder('o1', 'DELIVERED', [['Milk', 1, 'v-milk']])], endOfList: true }),
      [],
    );
    await expect(session.listPage(null)).rejects.toMatchObject({ code: 'internal' });
  });
});
