// Reading Instamart's order-list and catalog-search answers during an import
// (design Appendix C). The pure parts of the import adapter.
import { describe, expect, it } from 'vitest';

import { classifyOrdersResponse, exactPackLabel, nextOrdersCursor } from '../src/worker/adapters/instamart-import.js';
import { fakeOrder } from './fixtures/instamart.js';

describe('classifyOrdersResponse', () => {
  it('reads a page of orders', () => {
    const body = JSON.stringify({ statusCode: 0, data: { orders: [fakeOrder({ id: 'A', createdAt: 2000 }), fakeOrder({ id: 'B', createdAt: 1000 })] } });
    const r = classifyOrdersResponse(200, body);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.orders.map((o) => o.order_id)).toEqual(['A', 'B']);
  });

  it('an empty page is the end of history, not an error', () => {
    const r = classifyOrdersResponse(200, JSON.stringify({ statusCode: 0, data: { orders: [] } }));
    expect(r).toEqual({ kind: 'ok', orders: [] });
  });

  it('Instamart answering without orders means the session is no longer accepted', () => {
    expect(classifyOrdersResponse(200, JSON.stringify({ statusCode: 1, data: null }))).toEqual({ kind: 'unauthorized' });
    expect(classifyOrdersResponse(401, JSON.stringify({ statusCode: 401 }))).toEqual({ kind: 'unauthorized' });
  });

  it('anything that is not Instamart JSON — a bot challenge, a 5xx — is retryable, not a logout', () => {
    expect(classifyOrdersResponse(200, '<html>challenge</html>')).toEqual({ kind: 'unreachable' });
    expect(classifyOrdersResponse(503, JSON.stringify({ statusCode: 1 }))).toEqual({ kind: 'unreachable' });
    expect(classifyOrdersResponse(429, '')).toEqual({ kind: 'unreachable' });
  });
});

describe('nextOrdersCursor', () => {
  it("is 1 ms past the page's oldest order, so an order sharing the boundary millisecond is never skipped", () => {
    expect(nextOrdersCursor([fakeOrder({ id: 'A', createdAt: 5000 }), fakeOrder({ id: 'B', createdAt: 3000 })])).toBe(3001);
  });

  it('is null after an empty page', () => {
    expect(nextOrdersCursor([])).toBeNull();
  });
});

describe('exactPackLabel', () => {
  const search = {
    data: {
      cards: [
        {
          items: [
            { variations: [{ skuId: 'OTHER', quantityDescription: '1 kg' }, { skuId: 'SKU_SUGAR', spinId: 'X', quantityDescription: '1 kg' }] },
            { nested: { deeper: [{ skuId: 'SKU_MILK', quantityDescription: '500 ml' }] } },
          ],
        },
      ],
    },
  };

  it('finds the variation whose skuId is exactly the ordered SKU, anywhere in the response', () => {
    expect(exactPackLabel(search, 'SKU_SUGAR')).toBe('1 kg');
    expect(exactPackLabel(search, 'SKU_MILK')).toBe('500 ml');
  });

  it('is null when the SKU is not in the results — never the nearest match', () => {
    expect(exactPackLabel(search, 'SKU_GINGER')).toBeNull();
  });
});
