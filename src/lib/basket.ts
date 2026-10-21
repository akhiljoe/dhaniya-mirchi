import { readSeen, writeSeen, type Store } from './seen';
import { BASKET_DECLINED_KEY, BASKET_OFFERED_KEY, BASKET_SENT_KEY } from './constants';
// The items waiting to go into the vendor's cart (design §19 stage 1).
// Tapping "Add to cart" must be instant, so taps land here first and one Send
// fills them all in one trip through the app. Kept in the browser: it is a
// few taps in progress, not something the household needs on another device.
import { useCallback, useEffect, useState } from 'react';

import { productKey } from './products';

export interface BasketLine {
  item: string; // canonical item ("milk")
  // 'search': never bought here (a recipe's new ingredient), so the worker
  // takes what the store sells under that name (design §19).
  match?: 'exact' | 'search';
  name: string; // the item's name for the page ("Milk")
  emoji: string;
  product: string; // the app's own product name
  pack: string;
  qty: number;
}

const KEY = 'dm_basket';

function read(): BasketLine[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as BasketLine[];
    return Array.isArray(raw) ? raw.filter((l) => l && typeof l.item === 'string' && typeof l.product === 'string') : [];
  } catch {
    return [];
  }
}

function write(lines: BasketLine[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Not stored: the list still works until the page is closed.
  }
}

export function useBasket() {
  const [lines, setLines] = useState<BasketLine[]>(read);
  useEffect(() => write(lines), [lines]);

  const add = useCallback((line: BasketLine) => {
    setLines((all) => (all.some((l) => l.item === line.item) ? all : [...all, line]));
  }, []);
  const setQty = useCallback((item: string, qty: number) => {
    setLines((all) => all.map((l) => (l.item === item ? { ...l, qty } : l)));
  }, []);
  const setProduct = useCallback((item: string, product: string, pack: string) => {
    setLines((all) => all.map((l) => (l.item === item && productKey(l.product) !== productKey(product) ? { ...l, product, pack } : l)));
  }, []);
  const remove = useCallback((item: string) => setLines((all) => all.filter((l) => l.item !== item)), []);
  const clear = useCallback(() => setLines([]), []);

  return { lines, add, setQty, setProduct, remove, clear, has: (item: string) => lines.some((l) => l.item === item) };
}

export type Basket = ReturnType<typeof useBasket>;

// What the household has said about the list Home makes up for them.
//
// Home fills the basket without being asked, so emptying it has to mean
// something past the next reload. Two things are remembered: the list that
// was OFFERED, and the list that was turned down. They are compared, so they
// have to be the same kind of thing - the first version of this recorded the
// items still ticked in the cart bar and compared them against everything
// Home had offered, which never matched, so the bar came back every time.
//
// Per person and per browser, and nothing needs it back, so it is kept the
// way every other dismissal is (lib/seen.ts): guarded reads and writes that
// shrug when the browser refuses, and a store that can be handed in so this
// is testable without one.
export const declinedBasket = (store?: Store | null): string | null => readSeen(BASKET_DECLINED_KEY, store);
export const declineBasket = (signature: string, store?: Store | null): void => writeSeen(BASKET_DECLINED_KEY, signature, store);

// What Home last offered. The cart bar is where the household says no, and
// all it can see is what is still ticked, so it declines THIS instead.
// The list that was SENT. Home fills the basket without being asked, and
// sending it empties the basket - which looked to the next page load exactly
// like a household who had never been offered anything, so the same list was
// made up again and offered back the moment they refreshed. Saying no was
// remembered; saying yes was not.
//
// It stays blocked until the flagged list itself changes, which it does once
// the order syncs and those things stop being due. So this does not stop the
// app offering tomorrow's list - only today's, twice.
export const sentBasket = (store?: Store | null): string | null => readSeen(BASKET_SENT_KEY, store);
export const rememberSent = (signature: string, store?: Store | null): void => writeSeen(BASKET_SENT_KEY, signature, store);

export const lastOffer = (store?: Store | null): string | null => readSeen(BASKET_OFFERED_KEY, store);
export const rememberOffer = (signature: string, store?: Store | null): void => writeSeen(BASKET_OFFERED_KEY, signature, store);
