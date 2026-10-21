// Dismissals that survive a reload (seen.ts). Three notices have come back
// after being pushed away; these are the cases that catch a fourth.
import { describe, expect, it } from 'vitest';

import { readSeen, writeSeen, type Store } from './seen';

function fakeStore(): Store {
  const held = new Map<string, string>();
  return {
    getItem: (k) => held.get(k) ?? null,
    setItem: (k, v) => void held.set(k, v),
    removeItem: (k) => void held.delete(k),
  };
}
// One that refuses everything, the way a private window does.
const blocked: Store = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('remembering what was pushed away', () => {
  it('reads back what it was told to remember', () => {
    const s = fakeStore();
    writeSeen('dm.cart', 'cart-1', s);
    expect(readSeen('dm.cart', s)).toBe('cart-1');
  });

  it('remembers which one, so tomorrow s cart is a new notice', () => {
    const s = fakeStore();
    writeSeen('dm.cart', 'cart-1', s);
    expect(readSeen('dm.cart', s)).not.toBe('cart-2');
  });

  it('forgets on null', () => {
    const s = fakeStore();
    writeSeen('dm.cart', 'cart-1', s);
    writeSeen('dm.cart', null, s);
    expect(readSeen('dm.cart', s)).toBeNull();
  });

  it('says nothing about a notice never dismissed', () => {
    expect(readSeen('dm.never', fakeStore())).toBeNull();
  });

  it('shrugs when the browser refuses to store anything', () => {
    expect(() => writeSeen('dm.cart', 'cart-1', blocked)).not.toThrow();
    expect(readSeen('dm.cart', blocked)).toBeNull();
    expect(readSeen('dm.cart', null)).toBeNull();
  });
});
