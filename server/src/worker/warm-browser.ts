// A browser kept warm between jobs (design §19 stage 1). Starting Chromium
// costs about nine seconds, which was most of the time a small cart took, and
// a household often sends several carts in a row.
//
// It is shared, so each job takes its own *context*: contexts have their own
// cookies and storage, which is what keeps one household's session — and the
// page's saved copy of its cart — away from the next. The browser is closed
// once nothing has used it for CHROME_WARM_IDLE_MS, so an idle worker holds
// no browser.
import { CHROME_WARM_IDLE_MS } from '../constants.js';
import { launchHeadless, type HeadlessBrowser } from './chrome.js';

let shared: Promise<HeadlessBrowser> | null = null;
let users = 0;
let idleTimer: NodeJS.Timeout | null = null;

// One lease on the shared browser: `release` gives it back, and the browser
// closes a while after the last one is given back.
export interface BrowserLease {
  browser: HeadlessBrowser;
  release(): Promise<void>;
}

async function closeIfIdle(): Promise<void> {
  idleTimer = null;
  if (users > 0 || !shared) return;
  const held = shared;
  shared = null;
  await (await held).close().catch(() => undefined);
}

export async function leaseBrowser(launch: () => Promise<HeadlessBrowser> = () => launchHeadless()): Promise<BrowserLease> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  shared ??= launch();
  let browser: HeadlessBrowser;
  try {
    browser = await shared;
  } catch (err) {
    shared = null; // a failed start must not be handed to the next job
    throw err;
  }
  users++;
  let given = false;
  return {
    browser,
    release: async () => {
      if (given) return;
      given = true;
      users--;
      if (users === 0) idleTimer = setTimeout(() => void closeIfIdle(), CHROME_WARM_IDLE_MS);
    },
  };
}

// For shutdown: close it now, whoever holds it.
export async function closeWarmBrowser(): Promise<void> {
  users = 0;
  if (idleTimer) clearTimeout(idleTimer);
  await closeIfIdle();
}
