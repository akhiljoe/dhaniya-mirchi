// Browsers kept open between filling a cart and paying for it.
//
// What is parked is a live authenticated session to a grocery account with a
// saved card, so the guards are the point of this file: one browser is never
// driven by two jobs, one household is never handed another's, and nothing is
// left open when the worker stops.
import { describe, expect, it, vi } from 'vitest';

import { LiveCarts } from '../src/worker/live-carts.js';
import type { CartSession } from '../src/worker/adapters/instamart-cart.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fakeSession(): CartSession & { closed: number } {
  const s = {
    closed: 0,
    address: null,
    async close() {
      s.closed += 1;
    },
  };
  return s as unknown as CartSession & { closed: number };
}

describe('browsers parked between filling a cart and paying for it', () => {
  it('hands back the browser that filled that cart', () => {
    const carts = new LiveCarts(quiet);
    const s = fakeSession();
    carts.park('cart-1', 'house-1', s, 3);
    expect(carts.take('cart-1', 'house-1')).toEqual({ session: s, lines: 3 });
  });

  it('gives one browser to one job only', () => {
    const carts = new LiveCarts(quiet);
    carts.park('cart-1', 'house-1', fakeSession(), 3);
    expect(carts.take('cart-1', 'house-1')).not.toBeNull();
    // A retry, or a second order against the same cart, must open its own.
    expect(carts.take('cart-1', 'house-1')).toBeNull();
  });

  it('never hands one household a browser signed in as another', () => {
    const carts = new LiveCarts(quiet);
    const s = fakeSession();
    carts.park('cart-1', 'house-1', s, 3);
    expect(carts.take('cart-1', 'house-2')).toBeNull();
    // And it is still there for the household it belongs to.
    expect(carts.take('cart-1', 'house-1')).not.toBeNull();
  });

  it('says nothing is there when a cart job was never parked', () => {
    const carts = new LiveCarts(quiet);
    expect(carts.take('never-seen', 'house-1')).toBeNull();
    expect(carts.take(null, 'house-1')).toBeNull();
  });

  it('closes the browser when nobody comes for it', async () => {
    vi.useFakeTimers();
    try {
      const carts = new LiveCarts(quiet, 1000);
      const s = fakeSession();
      carts.park('cart-1', 'house-1', s, 1);
      vi.advanceTimersByTime(1001);
      await Promise.resolve();
      expect(s.closed).toBe(1);
      expect(carts.take('cart-1', 'house-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the oldest rather than holding browsers without limit', async () => {
    const carts = new LiveCarts(quiet, 60_000, 2);
    const first = fakeSession();
    carts.park('cart-1', 'house-1', first, 1);
    carts.park('cart-2', 'house-1', fakeSession(), 1);
    carts.park('cart-3', 'house-1', fakeSession(), 1);
    await Promise.resolve();
    expect(first.closed).toBe(1);
    expect(carts.size).toBe(2);
  });

  it('never keeps two browsers for one cart', async () => {
    const carts = new LiveCarts(quiet);
    const first = fakeSession();
    carts.park('cart-1', 'house-1', first, 1);
    const second = fakeSession();
    carts.park('cart-1', 'house-1', second, 2);
    await Promise.resolve();
    expect(first.closed).toBe(1);
    expect(carts.take('cart-1', 'house-1')?.session).toBe(second);
  });

  it('closes every one of them when the worker stops', async () => {
    const carts = new LiveCarts(quiet);
    const a = fakeSession();
    const b = fakeSession();
    carts.park('cart-1', 'house-1', a, 1);
    carts.park('cart-2', 'house-2', b, 1);
    await carts.closeAll();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(carts.size).toBe(0);
  });
});
