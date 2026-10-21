// Which of the app's questions this person waved away (design §9.12 Phase 4).
// A per-viewer convenience kept in the browser: if storage is unavailable
// (private window, cleared data) a question simply shows again — harmless.
import { SUGGEST_DISMISS_DAYS } from './constants';
import type { Suggestion } from './suggestions';

const KEY = 'dm_dismissed';
const DAY = 86_400_000;

function read(): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

// "Buying changed" is remembered by direction: the week it points at shifts
// as weeks pass, and the same change mustn't be asked about every week.
const keyOf = (s: Suggestion) => (s.kind === 'buying_changed' ? `buying_changed:${s.direction}` : s.id);

export function isDismissed(s: Suggestion, now: Date): boolean {
  const at = read()[keyOf(s)];
  if (at === undefined) return false;
  return s.kind !== 'buying_changed' || now.getTime() - at < SUGGEST_DISMISS_DAYS * DAY;
}

export function dismiss(s: Suggestion, now: Date): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...read(), [keyOf(s)]: now.getTime() }));
  } catch {
    // Not stored: it may ask again later.
  }
}
