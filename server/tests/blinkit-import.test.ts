// Reading Blinkit's order-list answers during an import, and the walk from a
// list page through each order's detail (design Appendix A).
import { describe, expect, it } from 'vitest';

import { absolutePath, BlinkitImportSession, classifyListResponse } from '../src/worker/adapters/blinkit-import.js';
import { blinkitSku } from '../src/worker/import/blinkit-parse.js';

describe('classifyListResponse', () => {
  it('reads a page of snippets', () => {
    const r = classifyListResponse(200, JSON.stringify({ response: { snippets: [{ widget_type: 'order_history_container_vr' }] } }));
    expect(r.kind).toBe('ok');
  });

  it('an empty snippet list is the end of history, not an error', () => {
    expect(classifyListResponse(200, JSON.stringify({ response: { snippets: [] } })).kind).toBe('ok');
  });

  it('Blinkit answering without snippets means the session is no longer accepted', () => {
    expect(classifyListResponse(200, JSON.stringify({ message: 'unauthorized' }))).toEqual({ kind: 'unauthorized' });
    expect(classifyListResponse(401, JSON.stringify({ success: false }))).toEqual({ kind: 'unauthorized' });
  });

  // Telling a household to reconnect costs them an OTP, so an edge hiccup must
  // never be read as a logout.
  it('anything that is not Blinkit JSON — the block page, a 5xx, a rate limit — is retryable', () => {
    expect(classifyListResponse(403, '<html>Access denied</html>')).toEqual({ kind: 'unreachable' });
    expect(classifyListResponse(200, '<html>challenge</html>')).toEqual({ kind: 'unreachable' });
    expect(classifyListResponse(503, JSON.stringify({ response: { snippets: [] } }))).toEqual({ kind: 'unreachable' });
    expect(classifyListResponse(429, '')).toEqual({ kind: 'unreachable' });
  });
});

describe('absolutePath', () => {
  it('takes next_url however Blinkit spells it', () => {
    expect(absolutePath('/v1/layout/order_history?page=2')).toBe('/v1/layout/order_history?page=2');
    expect(absolutePath('v1/layout/order_history?page=2')).toBe('/v1/layout/order_history?page=2');
    expect(absolutePath('https://blinkit.com/v1/layout/order_history?page=2')).toBe('https://blinkit.com/v1/layout/order_history?page=2');
  });
});

// One pass over a faked page: list → a detail call per order → parsed orders,
// the packs learned on the way, and the cursor for the next page.
describe('BlinkitImportSession.listPage', () => {
  const listSnippet = (orderId: string, cartId: string) => ({
    widget_type: 'order_history_container_vr',
    tracking: { common_attributes: { order_id: orderId, order_status: 'DELIVERED' } },
    data: { identity: { id: `order_${orderId}_${cartId}` }, items: [{ data: { left_underlined_subtitle: { text: '₹312 paid' } } }] },
  });
  const itemSnippet = (name: string, qty: string) => ({
    widget_type: 'z_v3_image_text_snippet_type_30',
    tracking: { widget_meta: { widget_name: 'order_details_list' } },
    data: { title: { text: name }, subtitle1: { text: qty }, subtitle3: { text: '₹54' } },
  });
  const detailBody = (placed: string | null, items: unknown[]) =>
    JSON.stringify({
      response: {
        snippets: [...(placed ? [{ widget_type: 'v2_image_text_snippet_type_30', data: { title: { text: placed } } }] : []), ...items],
      },
    });

  type Answer = { status: number; body: string };

  // Stands in for the loaded page: the adapter hands it one JS expression per
  // call, and the path it asked for is read back out of it.
  function sessionOver(answers: Record<string, Answer>, seen: string[]) {
    const page = {
      async evaluate(script: string) {
        const path = (JSON.parse(script.match(/const a = (\{.*?\});/s)![1]!) as { path: string }).path;
        seen.push(path);
        const answer = answers[path];
        if (!answer) throw new Error(`no fake answer for ${path}`);
        return answer;
      },
    };
    let closed = false;
    const hb = {
      browser: null as never,
      close: async () => {
        closed = true;
      },
    };
    return { session: new BlinkitImportSession(hb as never, page as never, () => ({ auth_key: 'k', device_id: 'd' }), 0), wasClosed: () => closed };
  }

  it('walks the list, fetches each order and learns its packs', async () => {
    const seen: string[] = [];
    const { session } = sessionOver(
      {
        '/v1/layout/order_history': {
          status: 200,
          body: JSON.stringify({
            response: { snippets: [listSnippet('111', '222'), listSnippet('333', '444')], pagination: { next_url: '/v1/layout/order_history?p=2' } },
            postback_params: { token: 'abc' },
          }),
        },
        '/v1/layout/order_details/111?cart_id=222': {
          status: 200,
          body: detailBody("placed on Sun, 13 Sep'26, 9:58 PM", [itemSnippet('Tata Salt', '1 kg x 1')]),
        },
        // No date: skipped, not stored on a guessed year (Appendix B).
        '/v1/layout/order_details/333?cart_id=444': { status: 200, body: detailBody(null, [itemSnippet('Amul Milk', '500 ml x 2')]) },
      },
      seen,
    );

    const page = await session.listPage(null);
    expect(seen).toEqual(['/v1/layout/order_history', '/v1/layout/order_details/111?cart_id=222', '/v1/layout/order_details/333?cart_id=444']);
    expect(page.orders.map((o) => o.vendorOrderId)).toEqual(['111']);
    expect(page.orders[0]!.placedAt).toBe('2026-09-13T16:28:00.000Z');
    expect(page.nextCursor).toEqual({ url: '/v1/layout/order_history?p=2', body: { token: 'abc' } });
    // The packs go back with the page, each carrying the store it belongs to.
    expect(page.packs).toEqual([{ sku: blinkitSku('Tata Salt', '1 kg'), storeId: 0, label: '1 kg' }]);
    // The pack came off the order line: no catalog call at all.
    expect(await session.packLabel(blinkitSku('Tata Salt', '1 kg'))).toBe('1 kg');
    // A sku no listing taught us is honestly unknown, never a near match.
    expect(await session.packLabel(blinkitSku('Amul Milk', '500 ml'))).toBeNull();
  });

  it('follows the cursor to the next page and stops when there is none', async () => {
    const seen: string[] = [];
    const { session } = sessionOver(
      {
        '/v1/layout/order_history?p=2': { status: 200, body: JSON.stringify({ response: { snippets: [listSnippet('555', '666')], pagination: {} } }) },
        '/v1/layout/order_details/555?cart_id=666': {
          status: 200,
          body: detailBody("placed on Mon, 1 Sep'26, 8:00 AM", [itemSnippet('Aashirvaad Atta', '5 kg x 1')]),
        },
      },
      seen,
    );

    const page = await session.listPage({ url: '/v1/layout/order_history?p=2', body: {} });
    expect(seen[0]).toBe('/v1/layout/order_history?p=2');
    expect(page.orders.map((o) => o.vendorOrderId)).toEqual(['555']);
    expect(page.nextCursor).toBeNull();
  });

  it('treats a session Blinkit no longer accepts as unauthorized', async () => {
    const { session } = sessionOver({ '/v1/layout/order_history': { status: 401, body: JSON.stringify({ success: false }) } }, []);
    await expect(session.listPage(null)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('closes the browser it was given', async () => {
    const { session, wasClosed } = sessionOver({}, []);
    await session.close();
    expect(wasClosed()).toBe(true);
  });
});
