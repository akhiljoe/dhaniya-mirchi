// "I have seen that, stop showing it."
//
// Every notice the app lets somebody push away has to stay pushed away past
// a reload. Three have not, at different times: the list Home made up came
// back every load, then the cart's "ready" line did, then the Pay card did.
// Each was plain component state, and component state does not survive F5.
// Pushing something away and having it return is the app arguing with the
// household.
//
// So dismissals go through here. What is remembered is WHICH thing was
// pushed away - a cart's id, the signature of a list - never a bare "hidden"
// flag, so a new cart tomorrow is a new notice and shows.
//
// Per person and per browser, and nothing on the server needs it back, so
// the browser is the right place. A private window, cleared site data or a
// blocked store all throw on these calls, and none of that should stop the
// page rendering: every read shrugs and returns null, every write shrugs and
// the notice shows again, which is the old behaviour and no worse. Every
// call takes its own store so this is testable without a browser.
import { useCallback, useState } from 'react';

export type Store = Pick<Storage, 'getItem' | 'setItem'> & { removeItem?: Storage['removeItem'] };

export function browserStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSeen(key: string, store: Store | null = browserStore()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSeen(key: string, id: string | null, store: Store | null = browserStore()): void {
  try {
    if (id) store?.setItem(key, id);
    else store?.removeItem?.(key);
  } catch {
    // Not stored: it shows again on the next reload.
  }
}

// What a dismissible notice holds instead of useState. It reads what was
// pushed away before the page loaded and writes every change, so surviving a
// reload is what a new notice gets by default rather than something somebody
// has to remember to add.
export function useSeen(key: string): [string | null, (id: string | null) => void] {
  const [seen, setSeen] = useState<string | null>(() => readSeen(key));
  const remember = useCallback(
    (id: string | null) => {
      setSeen(id);
      writeSeen(key, id);
    },
    [key],
  );
  return [seen, remember];
}
