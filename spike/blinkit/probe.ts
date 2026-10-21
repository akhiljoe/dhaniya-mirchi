// Phase 0 spike — DIAGNOSTIC probe.
//
// The raw-HTTP replay got 403 with an HTML block page on every scenario. That
// points at edge bot-detection (TLS/client fingerprint), not a token problem.
// This probe proves it: the SAME order_history request, made two ways —
//   1. Node fetch                      (non-browser TLS fingerprint)
//   2. from inside the logged-in Chrome via page.evaluate  (real Chrome)
// Same IP, same token, same headers. If (2) succeeds and (1) is blocked, the
// blocker is the client fingerprint, and the worker must drive a real browser.
//
//   npm run probe
//
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { SESSION_FILE, replayableHeaders, type CapturedSession } from './shared.ts';

const USER_DATA_DIR = './.userdata';

function classify(status: number, text: string): string {
  const head = text.slice(0, 2000).toLowerCase();
  const vendor =
    /cloudflare/.test(head) ? 'Cloudflare' :
    /akamai|reference #/.test(head) ? 'Akamai' :
    /perimeterx|px-captcha|human challenge/.test(head) ? 'PerimeterX' :
    /captcha|are you a robot|bot/.test(head) ? 'generic bot-challenge' :
    /access denied|forbidden/.test(head) ? 'access-denied page' : null;
  let kind: string;
  try {
    const j = JSON.parse(text);
    kind = /order|item|product|qty|quantity|snippet/i.test(JSON.stringify(j))
      ? 'JSON ✓ order data' : `JSON (keys: ${Object.keys(j).slice(0, 6).join(',')})`;
  } catch {
    kind = `HTML/${text.length} chars` + (vendor ? ` — ${vendor}` : '');
  }
  return `HTTP ${status} — ${kind}`;
}

async function main() {
  const s: CapturedSession = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  const headers = replayableHeaders(s.orderHistory.requestHeaders);
  const body = s.orderHistory.postData ?? JSON.stringify({ offset: 0, limit: 5 });

  // 1. Node fetch
  let nodeResult: string;
  try {
    const r = await fetch(s.orderHistory.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    nodeResult = classify(r.status, await r.text());
  } catch (e) {
    nodeResult = `ERR ${String(e)}`;
  }

  // 2. In-browser fetch, from the logged-in Chrome, same-origin.
  //    HEADLESS=1 tests the mode the worker actually runs in — headless Chrome
  //    has a different fingerprint and bot detection may treat it differently.
  const headless = process.env.HEADLESS === '1';
  console.log(`(browser mode: ${headless ? 'HEADLESS' : 'headful'})`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://blinkit.com/', { waitUntil: 'domcontentloaded' });
  // Carry the captured headers (which include the auth token). The browser
  // silently drops forbidden header names (cookie/host/user-agent/...) and
  // attaches the real cookie itself via credentials:include.
  const browserResult = await page.evaluate(
    async ([url, bodyStr, hdrs]) => {
      try {
        const r = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: hdrs as Record<string, string>,
          body: bodyStr as string,
        });
        const t = await r.text();
        return { status: r.status, sample: t.slice(0, 300000) };
      } catch (e) {
        return { status: -1, sample: String(e) };
      }
    },
    [s.orderHistory.url, body, headers] as const,
  );
  await context.close();

  console.log('\n=== same request, two clients (same IP, same token) ===\n');
  console.log(`1. Node fetch          : ${nodeResult}`);
  console.log(`2. In-browser fetch    : ${classify(browserResult.status, browserResult.sample)}`);

  console.log('\n--- verdict ---');
  const browserOk = browserResult.status === 200 && /order|item|product|qty|snippet/i.test(browserResult.sample);
  const nodeBlocked = !/HTTP 200 — JSON . order/i.test(nodeResult);
  if (browserOk && nodeBlocked) {
    console.log('CONFIRMED: the blocker is the client fingerprint, not the token or IP.');
    console.log('→ The worker must issue order_history from inside a real browser engine');
    console.log('  (Playwright page context), not a raw HTTP client.');
    console.log('→ Next question for the Oracle box: does the *browser-engine* request');
    console.log('  succeed from a datacenter IP? Run this probe there.');
  } else if (browserOk && !nodeBlocked) {
    console.log('Node also worked — the earlier 403 was transient. Re-run replay.ts.');
  } else {
    console.log('In-browser fetch did NOT return order data either. Token may have expired');
    console.log('or the endpoint/body changed. Re-run capture, then this probe immediately.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
