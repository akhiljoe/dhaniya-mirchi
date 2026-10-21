// Light, dark, or whatever the phone is set to (design §12.8).
//
// The palette itself is CSS custom properties (src/index.css): the class
// names mean roles, not colours - `bg-sand-50` is "the page", `text-ink-800`
// is "what you read" - so the whole app changes by swapping the values under
// `.dark` rather than by adding a dark variant to 888 class names.
//
// Kept per browser, like the other per-viewer conveniences: a private window
// or blocked storage simply falls back to the phone's own setting.
import { THEME_KEY } from './constants';

export type Theme = 'system' | 'light' | 'dark';

const isTheme = (x: unknown): x is Theme => x === 'system' || x === 'light' || x === 'dark';

export function readTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return isTheme(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function writeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not stored: this session follows it, the next one asks the phone again.
  }
}

// Whether a choice means dark right now. "system" asks the phone, and the
// answer changes when the phone's own setting does.
export function isDark(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

// Put it on the page: the class the palette hangs off, `color-scheme` so form
// controls and scrollbars follow, and the browser chrome's own colour.
export function applyTheme(theme: Theme): void {
  const dark = isDark(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#16140f' : '#faf8f5');
}

// Follow the phone while the choice is "system". Returns the unsubscribe.
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}
