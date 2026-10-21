// Go/no-go: can Blinkit be read from a HEADLESS browser?
//
// `HEADLESS=1 npm run probe` (a Playwright-launched headless Chromium) is
// blocked: the in-browser order_history fetch gets a 403 HTML page, while the
// same probe headful gets 200. This tests the launch path that works for
// Instamart (spike/instamart/shared.ts): the installed Chrome spawned plainly
// with --headless=new, attached over CDP — in a FRESH profile, carrying the
// captured session (cookies + header token from session.json), exactly as the
// server worker would restore a stored session. Two variants:
//   1. --headless=new as-is ("HeadlessChrome" user agent)
//   2. --headless=new with a normal Chrome user agent
//
//   npm run probe:headless
//
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SESSION_FILE, replayableHeaders, type CapturedSession } from './shared.ts';

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROBE_PORT = 9335;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // already exited
  }
}

async function runVariant(name: string, extraArgs: string[], s: CapturedSession): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'blinkit-headless-'));
  const chrome = spawn(
    CHROME_PATH,
    ['--headless=new', `--remote-debugging-port=${PROBE_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', ...extraArgs, 'about:blank'],
    { stdio: 'ignore' },
  );
  try {
    let browser = null;
    for (let i = 0; i < 40 && !browser; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${PROBE_PORT}`);
      } catch {
        await sleep(500);
      }
    }
    if (!browser) throw new Error('could not attach to headless Chrome');
    const context = browser.contexts()[0];

    // Restore the stored session: cookies for blinkit.com …
    const cookies = s.cookieHeader
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return { name: c.slice(0, i), value: c.slice(i + 1), domain: '.blinkit.com', path: '/' };
      });
    await context.addCookies(cookies);

    const page = await context.newPage();
    const nav = await page.goto('https://blinkit.com/', { waitUntil: 'load', timeout: 45_000 });
    await page.waitForTimeout(3000);
    const ua = await page.evaluate('navigator.userAgent');

    // … and the header token, sent with the in-page fetch (as probe.ts does).
    const args = JSON.stringify({
      url: s.orderHistory.url,
      body: s.orderHistory.postData ?? JSON.stringify({ offset: 0, limit: 5 }),
      headers: replayableHeaders(s.orderHistory.requestHeaders),
    });
    const r = (await page.evaluate(`(async () => {
      const a = ${args};
      const r = await fetch(a.url, { method: 'POST', credentials: 'include', headers: a.headers, body: a.body });
      return { status: r.status, text: await r.text() };
    })()`)) as { status: number; text: string };

    let verdict: string;
    try {
      JSON.parse(r.text);
      verdict = /order|snippet/i.test(r.text) ? 'PASS — order JSON' : 'JSON without orders';
    } catch {
      verdict = `FAIL — HTML ${r.text.length} chars`;
    }
    console.log(`\n=== ${name} ===`);
    console.log(`page load: HTTP ${nav?.status()}`);
    console.log(`userAgent: ${ua}`);
    console.log(`order_history: HTTP ${r.status} → ${verdict}`);
    await browser.close().catch(() => {});
  } finally {
    killTree(chrome.pid);
    await sleep(1500);
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const s: CapturedSession = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  const version = execSync(`powershell -NoProfile -Command "(Get-Item '${CHROME_PATH}').VersionInfo.ProductVersion"`)
    .toString()
    .trim();
  const normalUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  await runVariant('installed Chrome, headless (default UA)', [], s);
  await runVariant('installed Chrome, headless (normal Chrome UA)', [`--user-agent=${normalUa}`], s);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
