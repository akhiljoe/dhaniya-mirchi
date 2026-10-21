// Go/no-go: can Instamart be read from a HEADLESS browser?
//
// The product is a website: the user gives phone + OTP on our site and the
// worker reads orders in the background with no visible browser (design §7.5,
// §7.10). Swiggy already blocks a Playwright-launched browser, so this tests the
// launch path that works headful — installed Chrome spawned plainly, attached
// over CDP — but headless, in two variants:
//   1. --headless=new as-is (its user agent says "HeadlessChrome")
//   2. --headless=new with a normal Chrome user agent
// Each variant loads instamart.in and fetches one page of orders with the
// login saved in .chromedata by `npm run capture`.
//
//   npm run probe:headless
//
// Close any other window using the .chromedata profile first.
import { spawn, execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { CHROME_PATH, ORIGIN, USER_DATA_DIR, pageFetch, sleep } from './shared.ts';

const PROBE_PORT = 9334;

interface Variant {
  name: string;
  extraArgs: (normalUa: string) => string[];
}

const VARIANTS: Variant[] = [
  { name: 'headless (default UA)', extraArgs: () => [] },
  { name: 'headless (normal Chrome UA)', extraArgs: (ua) => [`--user-agent=${ua}`] },
];

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {
    // already exited
  }
}

async function runVariant(v: Variant, normalUa: string): Promise<void> {
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${PROBE_PORT}`,
      `--user-data-dir=${resolve(USER_DATA_DIR)}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...v.extraArgs(normalUa),
      'about:blank',
    ],
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
    const page = await browser.contexts()[0].newPage();
    const nav = await page.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForTimeout(4000);
    const ua = await page.evaluate('navigator.userAgent');
    const webdriver = await page.evaluate('navigator.webdriver');
    const text = String(await page.evaluate('document.body.innerText.slice(0, 120)')).replace(/\s+/g, ' ');
    const r = await pageFetch(page, `/api/instamart/orders?order_type=DASH&count=20&from_time=${Date.now()}`);
    let verdict: string;
    try {
      const n = (JSON.parse(r.body).data?.orders ?? []).length;
      verdict = n > 0 ? `PASS — ${n} orders returned` : 'JSON but no orders (logged out?)';
    } catch {
      verdict = `FAIL — non-JSON (${r.body.length} B): ${r.body.slice(0, 100).replace(/\s+/g, ' ')}`;
    }
    console.log(`\n=== ${v.name} ===`);
    console.log(`page load: HTTP ${nav?.status()}  | page text: "${text}"`);
    console.log(`userAgent: ${ua}`);
    console.log(`navigator.webdriver: ${webdriver}`);
    console.log(`orders API: HTTP ${r.status} → ${verdict}`);
    await browser.close().catch(() => {});
  } finally {
    killTree(chrome.pid);
    await sleep(1500); // let the profile lock release before the next variant
  }
}

async function main() {
  // A normal (headful) Chrome UA for variant 2: the installed Chrome's version,
  // with "HeadlessChrome" replaced — read from the browser itself, not guessed.
  const version = execSync(`powershell -NoProfile -Command "(Get-Item '${CHROME_PATH}').VersionInfo.ProductVersion"`)
    .toString()
    .trim();
  const normalUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  for (const v of VARIANTS) await runVariant(v, normalUa);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
