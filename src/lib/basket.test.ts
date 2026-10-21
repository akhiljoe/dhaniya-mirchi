// Saying no to the list Home made up (basket.ts).
//
// Home fills the basket without being asked, so emptying it has to mean
// something past the next reload. It did not, twice, for two different
// reasons - first because nothing was remembered at all, then because the
// wrong thing was remembered - and both times the household saw the same bar
// come back every single time they loaded the page.
import { beforeEach, describe, expect, it } from 'vitest';

import { declineBasket, declinedBasket, lastOffer, rememberOffer, rememberSent, sentBasket } from './basket';

// A store of its own, so this needs no browser. The real one is
// window.localStorage and behaves the same way.
function fakeStore() {
  const held = new Map<string, string>();
  return {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
  };
}
// One that refuses everything, the way a private window does.
const blocked = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

let store = fakeStore();

// What Home offers, and what is left ticked in the cart bar by the time the
// household presses the X on it.
const OFFERED = ['banana', 'butter', 'coconut', 'coriander', 'milk', 'yogurt'].join(',');
const STILL_TICKED = ['butter', 'coriander'].join(',');

beforeEach(() => {
  store = fakeStore();
});

describe('turning the list down', () => {
  it('remembers the list that was offered, not the part still ticked', () => {
    rememberOffer(OFFERED, store);
    // The cart bar takes what Home offered, and falls back to its own lines
    // only when Home never got the chance to offer anything.
    declineBasket(lastOffer(store) ?? STILL_TICKED, store);
    expect(declinedBasket(store)).toBe(OFFERED);
  });

  // The bug, written down. Recording the survivors meant comparing 2 against
  // the 6 that were offered, which never matched, so it refilled every time.
  it('matches the list Home checks against, so the same one is not offered twice', () => {
    rememberOffer(OFFERED, store);
    declineBasket(lastOffer(store) ?? STILL_TICKED, store);
    expect(declinedBasket(store) === OFFERED).toBe(true);
    expect(declinedBasket(store) === STILL_TICKED).toBe(false);
  });

  // A different list is a different question: something else has run low.
  it('offers a list again once it has changed', () => {
    rememberOffer(OFFERED, store);
    declineBasket(lastOffer(store)!, store);
    const withBread = [...OFFERED.split(','), 'bread'].sort().join(',');
    expect(declinedBasket(store) === withBread).toBe(false);
  });

  it('has nothing to say before anything has been offered', () => {
    expect(lastOffer(store)).toBeNull();
    expect(declinedBasket(store)).toBeNull();
  });

  // A private window, cleared site data or a blocked store all throw here,
  // and none of that should stop the page rendering.
  it('shrugs when the browser will not store anything', () => {
    expect(() => rememberOffer(OFFERED, blocked)).not.toThrow();
    expect(() => declineBasket(OFFERED, blocked)).not.toThrow();
    expect(lastOffer(blocked)).toBeNull();
    expect(declinedBasket(blocked)).toBeNull();
  });
});

// Saying yes has to be remembered the way saying no is. It was not: sending
// emptied the basket, and the next page load saw an empty basket and made
// the same list up again - so the household got the list they had just sent
// offered straight back at them on refresh.
describe('a list that was sent', () => {
  it('is remembered, so it is not offered back', () => {
    const s = fakeStore();
    rememberSent('bread,milk', s);
    expect(sentBasket(s)).toBe('bread,milk');
  });

  it('is kept apart from a list that was turned down', () => {
    const s = fakeStore();
    rememberSent('bread,milk', s);
    expect(declinedBasket(s)).toBeNull();
  });

  // Tomorrow's list is a different list, and it still gets offered.
  it('does not block a list that has since changed', () => {
    const s = fakeStore();
    rememberSent('bread,milk', s);
    expect(sentBasket(s)).not.toBe('bread,eggs,milk');
  });

  it('shrugs when the browser refuses to store it', () => {
    expect(() => rememberSent('bread,milk', blocked)).not.toThrow();
    expect(sentBasket(blocked)).toBeNull();
  });
});
