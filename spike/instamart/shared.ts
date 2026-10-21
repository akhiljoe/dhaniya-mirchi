// Shared plumbing for the Instamart spike.
//
// Swiggy's edge blocks a Playwright-*launched* browser at the first page load
// ("Your request looks automated"), and instamart.in additionally loads an AWS
// WAF challenge. So Playwright never launches Chrome here: we start the
// installed Chrome as a plain process (no --enable-automation, no webdriver
// flag) with a debugging port, and only *attach* over CDP. All API calls are
// made by `fetch` inside the logged-in instamart.in page — the page's own
// origin, cookies and fingerprint.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

// A dedicated Chrome profile for the spike (not your everyday one): persists
// the instamart.in login across runs. Gitignored.
export const USER_DATA_DIR = './.chromedata';
export const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const CDP_PORT = 9333;
export const ORIGIN = 'https://instamart.in';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Detached, so stopping a script leaves the window (and a half-done login)
// alive for the next one to attach to.
function launchChrome(startUrl: string): void {
  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${resolve(USER_DATA_DIR)}`,
      '--no-first-run',
      '--no-default-browser-check',
      startUrl,
    ],
    { stdio: 'ignore', detached: true },
  );
  chrome.on('error', (e) => {
    console.error(`[fail] could not start Chrome at ${CHROME_PATH}:`, e.message);
    process.exit(1);
  });
  chrome.unref();
}

// Attach to the spike Chrome, launching it first if it isn't running.
export async function attachChrome(startUrl = `${ORIGIN}/`): Promise<Browser> {
  const up = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(
    () => true,
    () => false,
  );
  if (!up) launchChrome(startUrl);
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch (e) {
      last = e;
      await sleep(500); // Chrome takes a moment to open its debugging port
    }
  }
  throw last;
}

// A fresh instamart.in tab, loaded, for in-page fetches.
export async function openInstamartPage(browser: Browser): Promise<Page> {
  const page = await browser.contexts()[0].newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
  await page.waitForTimeout(3000); // let the WAF challenge + app bootstrap settle
  return page;
}

export interface FetchResult {
  status: number;
  body: string;
}

// fetch() from inside the page. The code is passed as a string, not a closure:
// tsx/esbuild injects a `__name` helper into compiled closures that does not
// exist in the browser context.
export async function pageFetch(
  page: Page,
  path: string,
  init: { method?: 'GET' | 'POST'; json?: unknown } = {},
): Promise<FetchResult> {
  const args = JSON.stringify({
    path,
    method: init.method ?? 'GET',
    body: init.json === undefined ? null : JSON.stringify(init.json),
  });
  return page.evaluate(`(async () => {
    const a = ${args};
    const r = await fetch(a.path, {
      method: a.method,
      credentials: 'include',
      headers: a.body ? { 'content-type': 'application/json' } : {},
      body: a.body,
    });
    return { status: r.status, body: await r.text() };
  })()`) as Promise<FetchResult>;
}

// A pack label from the catalog ("500 ml", "1 kg", "330 ml x 2", "75 Pieces",
// "200 g x 2", "1 pc", "1 Bunch") → one pack's size + unit. Multipacks fold
// into the pack ("330 ml x 2" → 660 ml). Countable catalog units — bunch
// (coriander, curry leaves), pack, small coconut — are pieces: the label *is*
// the unit the store sells, so this is read, not guessed. "1 dozen" → 12.
// Returns null when the label has no parseable size — the caller records the
// pack as unknown rather than guessing.
export function parsePackLabel(label: string): { pack: number; unit: string } | null {
  const s = label.trim().toLowerCase();
  const mult = s.match(/[x×]\s*(\d+)\s*$/);
  const times = mult ? Number(mult[1]) : 1;
  const m = s.match(
    /(\d+(?:\.\d+)?)\s*(ml|l|ltr|litre|kg|g|gm|gms|pcs?|pieces?|units?|sheets?|pulls?|bunch(?:es)?|packs?|small|medium|large|dozen)\b/,
  );
  if (!m) return null;
  const u = m[2];
  const n = Number(m[1]) * times * (u === 'dozen' ? 12 : 1);
  if (u === 'ml') return { pack: n, unit: 'ml' };
  if (u === 'l' || u === 'ltr' || u === 'litre') return { pack: n, unit: 'l' };
  if (u === 'kg') return { pack: n, unit: 'kg' };
  if (u === 'g' || u === 'gm' || u === 'gms') return { pack: n, unit: 'g' };
  return { pack: n, unit: 'piece' };
}
