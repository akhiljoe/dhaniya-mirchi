// What the one line at the bottom says about the cart.
//
// The order of precedence is the whole design: a cart being filled beats
// everything, a list being made beats carts that are ready, and a cart the
// household has pushed away is over. Each of those has been got wrong once on
// the real screen, so each is pinned here.
import { describe, expect, it } from 'vitest';

import type { CartJobSummary } from './cart';
import { dismissWith, dockState, elsewhereFor, idsOf, isDismissed, latestPerVendor, payable } from './dock';

const job = (over: Partial<CartJobSummary>): CartJobSummary => ({
  id: 'j1',
  status: 'done',
  vendor: 'blinkit',
  items: 3,
  result: { bill: { itemTotal: 100, toPay: 138, delivery: 30, surge: null, smallCart: null }, lines: [] },
  errorCode: null,
  at: '2026-09-23T10:00:00Z',
  ...over,
});
const line = { item: 'milk', name: 'Milk', emoji: '🥛', product: 'Amul Taaza', pack: '500 ml', qty: 1 };
// Half an hour after the fixture cart was filled.
const now = new Date('2026-09-23T10:30:00Z');
const base = { basket: [], active: [], jobs: [], dismissed: null, vendor: 'blinkit', now };

describe('what the cart line says', () => {
  it('says nothing when there is nothing', () => {
    expect(dockState(base)).toEqual({ kind: 'hidden' });
  });

  it('a cart being filled beats everything else', () => {
    const filling = job({ id: 'j2', status: 'running' });
    const s = dockState({ ...base, basket: [line], active: [filling], jobs: [job({})] });
    expect(s.kind).toBe('filling');
  });

  it('a list being made beats carts that are ready, and keeps them reachable', () => {
    const s = dockState({ ...base, basket: [line], jobs: [job({})] });
    expect(s.kind).toBe('picking');
    if (s.kind === 'picking') expect(s.ready.map((j) => j.id)).toEqual(['j1']);
  });

  it('one ready cart per app, the newest', () => {
    const older = job({ id: 'old', at: '2026-09-23T09:00:00Z' });
    const other = job({ id: 'im', vendor: 'instamart', at: '2026-09-23T10:30:00Z' });
    const s = dockState({ ...base, jobs: [older, job({}), other] });
    expect(s.kind).toBe('ready');
    if (s.kind === 'ready') expect(s.jobs.map((j) => j.id)).toEqual(['im', 'j1']);
  });

  it('a cart that was pushed away is over, and only that one', () => {
    // WHICH cart, not a bare flag: tomorrow's cart is a new notice.
    expect(dockState({ ...base, jobs: [job({})], dismissed: 'j1' })).toEqual({ kind: 'hidden' });
    const s = dockState({ ...base, jobs: [job({}), job({ id: 'im', vendor: 'instamart' })], dismissed: 'j1' });
    if (s.kind === 'ready') expect(s.jobs.map((j) => j.id)).toEqual(['im']);
    else throw new Error(s.kind);
  });

  it('a failed cart is said in the store s own words, when nothing is ready', () => {
    const s = dockState({ ...base, jobs: [job({ status: 'failed', errorCode: 'empty_cart', result: null })] });
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') expect(s.text.length).toBeGreaterThan(0);
  });

  it('a failure on one app does not hide a ready cart on the other', () => {
    const s = dockState({ ...base, jobs: [job({ id: 'f', vendor: 'instamart', status: 'failed', errorCode: 'empty_cart', result: null, at: '2026-09-23T11:00:00Z' }), job({})] });
    expect(s.kind).toBe('ready');
  });
});

describe('paying for a ready cart', () => {
  it('offers Pay when the app allows it and there is an amount', () => {
    expect(payable(job({}), true)).toEqual({ toPay: 138, canPay: true });
  });
  it('never offers Pay when paying is switched off', () => {
    expect(payable(job({}), false).canPay).toBe(false);
  });
});

describe('remembering which carts were pushed away', () => {
  it('holds several ids in one string', () => {
    const d = dismissWith(dismissWith(null, 'a'), 'b');
    expect(isDismissed(d, 'a')).toBe(true);
    expect(isDismissed(d, 'b')).toBe(true);
    expect(isDismissed(d, 'c')).toBe(false);
  });
  it('does not grow without end', () => {
    let d: string | null = null;
    for (let i = 0; i < 20; i++) d = dismissWith(d, `j${i}`);
    expect(d!.split(',').length).toBeLessThanOrEqual(8);
    expect(isDismissed(d, 'j19')).toBe(true);
  });
  it('leaves out the ones pushed away', () => {
    expect(latestPerVendor([job({})], 'j1', now)).toEqual([]);
  });
});

describe('several sends to one app', () => {
  const line = (item: string, at: string) => ({ item, product: item, pack: '', wanted: 1, inCart: 1, state: 'added' as const, price: null, note: at });
  const first = job({ id: 'a', at: '2026-09-23T09:50:00Z', result: { lines: [line('milk', 'a'), line('bread', 'a'), line('eggs', 'a')] } });
  const second = job({ id: 'b', at: '2026-09-23T10:00:00Z', result: { lines: [line('chicken', 'b')] } });

  it('are one cart, with every line', () => {
    // Real: three things sent, then chicken sent after; the tab showed only
    // the chicken, though the store's cart held all four.
    const [cart] = latestPerVendor([first, second], null, now);
    expect(cart.id).toBe('b');
    expect((cart.result?.lines ?? []).map((l) => l.item).sort()).toEqual(['bread', 'chicken', 'eggs', 'milk']);
    expect(idsOf(cart).sort()).toEqual(['a', 'b']);
  });

  it('take the newest line for a thing sent twice', () => {
    const again = job({ id: 'c', at: '2026-09-23T10:10:00Z', result: { lines: [line('milk', 'c')] } });
    const [cart] = latestPerVendor([first, again], null, now);
    expect(cart.result?.lines?.find((l) => l.item === 'milk')?.note).toBe('c');
    expect(cart.result?.lines).toHaveLength(3);
  });

  it('leave a dismissed send out of the fold', () => {
    const [cart] = latestPerVendor([first, second], 'a', now);
    expect((cart.result?.lines ?? []).map((l) => l.item)).toEqual(['chicken']);
    expect(idsOf(cart)).toEqual(['b']);
  });

  it('a cart never folded stands for its own id', () => {
    expect(idsOf(job({}))).toEqual(['j1']);
  });
});

describe('a cart with an order on it', () => {
  const line = (item: string) => ({ item, product: item, pack: '', wanted: 1, inCart: 1, state: 'added' as const, price: null, note: null });
  const first = job({ id: 'a', at: '2026-09-23T09:50:00Z', result: { lines: [line('milk')] } });
  const paidFor = job({ id: 'b', at: '2026-09-23T10:00:00Z', ordered: true, result: { lines: [line('cheese')] } });

  it('is over, and is never offered Pay again', () => {
    // Real: an order went through while the payment sheet was closed, and the
    // cart came back as "ready · Pay on Instamart" on the next load.
    expect(latestPerVendor([paidFor], null, now)).toEqual([]);
    expect(dockState({ ...base, jobs: [paidFor] })).toEqual({ kind: 'hidden' });
  });

  it('takes every earlier send to that app with it', () => {
    // The order was tied to the latest send but paid for the whole cart; the
    // send before it must not come back as a cart of its own.
    expect(latestPerVendor([first, paidFor], null, now)).toEqual([]);
  });

  it('leaves a later send, and the other app, alone', () => {
    const later = job({ id: 'c', at: '2026-09-23T10:20:00Z', result: { lines: [line('bread')] } });
    const other = job({ id: 'd', vendor: 'blinkit', at: '2026-09-23T09:55:00Z' });
    expect(latestPerVendor([first, paidFor, later, other], null, now).map((j) => j.id).sort()).toEqual(['c', 'd']);
  });
});

describe('how long a cart stays ready', () => {
  it('a cart from yesterday is not a cart any more', () => {
    // Real: an Instamart cart from the night before sat beside this
    // morning's Blinkit one as "ready · ₹705".
    const yesterday = job({ id: 'old', vendor: 'instamart', at: '2026-09-22T22:54:00Z' });
    expect(latestPerVendor([yesterday, job({})], null, now).map((j) => j.id)).toEqual(['j1']);
  });
  it('a cart from this morning still is', () => {
    const morning = job({ id: 'am', vendor: 'instamart', at: '2026-09-23T07:00:00Z' });
    expect(latestPerVendor([morning, job({})], null, now).map((j) => j.id)).toEqual(['j1', 'am']);
  });
});

describe('where else the household buys what the store would not sell', () => {
  const items = [
    { id: 'banana', name: 'Banana', emoji: '🍌', products: [{ name: 'Yelakki Banana', pack: '500 g', vendors: ['instamart'], recent: 3, total: 9, usualCount: 1, lastAt: '' }] },
    { id: 'guava', name: 'Guava', emoji: '🍈', products: [{ name: 'Thai Guava', pack: '500 g', vendors: ['blinkit'], recent: 1, total: 2, usualCount: 1, lastAt: '' }] },
  ];
  const miss = (item: string) => ({ item, product: item, pack: '', wanted: 1, inCart: 0, state: 'not_listed' as const, price: null, note: null });

  it('groups the misses by the other app that has sold them', () => {
    const { elsewhere, nowhere } = elsewhereFor([miss('banana'), miss('guava')], items, [], ['instamart', 'blinkit'], 'blinkit');
    expect(elsewhere).toEqual([{ vendor: 'instamart', lines: [expect.objectContaining({ item: 'banana', product: 'Yelakki Banana' })] }]);
    expect(nowhere).toEqual(['Guava']);
  });

  it('only counts apps a cart can actually go to', () => {
    const { elsewhere, nowhere } = elsewhereFor([miss('banana')], items, [], ['blinkit'], 'blinkit');
    expect(elsewhere).toEqual([]);
    expect(nowhere).toEqual(['Banana']);
  });
});
