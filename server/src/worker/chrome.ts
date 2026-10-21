// Launching the worker's browser (design §7.10). The recipe proven against
// both vendors: spawn the installed browser ourselves — never a
// Playwright-launched one, which Swiggy blocks — headless, with a NORMAL
// Chrome user agent (Blinkit 403s "HeadlessChrome"), then attach over CDP.
//
// In the container the browser is Debian's Chromium: Google ships no Chrome
// for Linux ARM, which is what the Oracle VM runs. The user agent uses the
// frozen Linux platform token Chrome itself sends ("X11; Linux x86_64" on
// every Linux architecture, per Chrome's UA reduction).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser } from 'playwright-core';

import {
  CHROME_ATTACH_ATTEMPTS,
  CHROME_ATTACH_INTERVAL_MS,
  CHROME_EXIT_TIMEOUT_MS,
  PROFILE_RM_RETRIES,
  PROFILE_RM_RETRY_DELAY_MS,
} from '../constants.js';

export const DEFAULT_CHROME_PATH = '/usr/bin/chromium';

export interface HeadlessBrowser {
  browser: Browser;
  version: string;
  userAgent: string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// "Chromium 139.0.7258.66 built on Debian..." / "Google Chrome 152.0.7977.83" → "139.0.7258.66"
export function parseBrowserVersion(output: string): string | null {
  return output.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export function normalUserAgent(version: string): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

// `knownVersion`: for browsers that don't print their version (Windows Chrome
// prints nothing for --version); Linux Chromium in the container does. It
// falls back to CHROME_VERSION for the same reason CHROME_PATH is read from
// the environment: that is how a worker command is run against the real
// vendor from a Windows host, and without it every one of them stops here.
export async function launchHeadless(
  chromePath: string = process.env.CHROME_PATH ?? DEFAULT_CHROME_PATH,
  knownVersion: string | undefined = process.env.CHROME_VERSION,
): Promise<HeadlessBrowser> {
  const version = knownVersion || parseBrowserVersion(execFileSync(chromePath, ['--version']).toString());
  if (!version) throw new Error(`could not read the browser version from ${chromePath}`);
  const userAgent = normalUserAgent(version);
  const profile = mkdtempSync(join(tmpdir(), 'dm-chrome-'));

  const proc: ChildProcess = spawn(
    chromePath,
    [
      '--headless=new',
      `--user-agent=${userAgent}`,
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      // In a container: no user namespaces for Chrome's sandbox (the container
      // is the isolation boundary), and a small /dev/shm.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    // Its own process group, so the renderers, GPU and zygote processes can be
    // killed together with it (they outlive a kill of the main process alone).
    { stdio: 'ignore', detached: true },
  );

  // Port 0 = Chrome picks a free port, so several browsers can run at once;
  // it writes the port it chose to <profile>/DevToolsActivePort.
  let browser: Browser | null = null;
  let lastErr: unknown;
  for (let i = 0; i < CHROME_ATTACH_ATTEMPTS && !browser; i++) {
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      if (!/^\d+$/.test(port)) throw new Error('DevToolsActivePort not written yet');
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (err) {
      lastErr = err;
      await sleep(CHROME_ATTACH_INTERVAL_MS);
    }
  }
  // Kill the whole process group, then WAIT for exit before deleting the
  // profile: Chromium and its child processes keep writing to it while they
  // die, and deleting under them fails with ENOTEMPTY (seen: it crashed the
  // worker on startup, and again after a probe).
  const cleanup = async () => {
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      try {
        process.kill(-proc.pid, 'SIGKILL'); // negative pid = the process group
      } catch {
        proc.kill('SIGKILL');
      }
      await Promise.race([exited, sleep(CHROME_EXIT_TIMEOUT_MS)]);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: PROFILE_RM_RETRIES, retryDelay: PROFILE_RM_RETRY_DELAY_MS });
  };
  if (!browser) {
    await cleanup();
    throw new Error(`could not attach to the headless browser: ${(lastErr as Error)?.message ?? 'unknown'}`);
  }
  return {
    browser,
    version,
    userAgent,
    close: async () => {
      await browser!.close().catch(() => undefined);
      await cleanup();
    },
  };
}
