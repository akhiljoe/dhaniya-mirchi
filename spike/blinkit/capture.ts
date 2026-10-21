// Phase 0 spike — STEP 1: capture.
//
// Opens a real Chromium window. YOU log into Blinkit with your phone + OTP.
// Once you're in, the script drives the Orders page, intercepts the page's own
// `order_history` request, and saves everything replay.ts needs to session.json.
//
// This runs on YOUR machine against YOUR account. The token never leaves your
// machine except back to Blinkit. session.json is gitignored.
//
//   npm run capture
//
import { writeFileSync } from 'node:fs';
import { chromium, type Request as PwRequest } from 'playwright';
import {
  ORDER_HISTORY_URL,
  SESSION_FILE,
  decodeJwtMeta,
  type CapturedSession,
  type TokenMeta,
} from './shared.ts';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for you to enter phone + OTP

const USER_DATA_DIR = './.userdata'; // persists login across runs; gitignored

async function main() {
  // Persistent context so a re-run reuses the login instead of another OTP.
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());

  // Capture the order_history exchange as soon as the page makes it.
  let captured: {
    request: PwRequest;
    headers: Record<string, string>;
    postData: string | null;
    status: number;
  } | null = null;

  page.on('response', async (res) => {
    const req = res.request();
    if (!req.url().includes('/v1/layout/order_history')) return;
    if (captured) return; // first one is enough
    try {
      captured = {
        request: req,
        headers: await req.allHeaders(),
        postData: req.postData(),
        status: res.status(),
      };
      console.log(`\n[captured] order_history → HTTP ${res.status()}`);
    } catch (e) {
      console.warn('[capture] failed to read order_history request:', e);
    }
  });

  await page.goto('https://blinkit.com/');

  console.log('\n=================================================================');
  console.log(' Log into Blinkit in the browser window (phone + OTP).');
  console.log(' Enter your delivery pincode if it asks.');
  console.log(' The script waits until you are logged in, then reads Orders.');
  console.log('=================================================================\n');

  // Wait until logged in: the `user` object appears in localStorage.
  await page.waitForFunction(
    () => {
      try {
        const u = JSON.parse(localStorage.getItem('user') || 'null');
        return !!(u && u.id);
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: LOGIN_TIMEOUT_MS, polling: 1000 },
  );
  console.log('[ok] logged in.');

  // Trigger order_history by loading the Orders page fresh.
  await page.goto('https://blinkit.com/account/orders', { waitUntil: 'networkidle' });

  // Give the interception a moment if it hasn't fired yet.
  for (let i = 0; i < 20 && !captured; i++) {
    await page.waitForTimeout(500);
  }

  if (!captured) {
    console.error(
      '\n[fail] Never saw an order_history request. Are there any orders on the account?\n' +
        'Try clicking "Orders" in the account menu manually, then re-run.',
    );
    await context.close();
    process.exit(1);
  }

  const cap = captured as NonNullable<typeof captured>;

  // Cookies (for the cookie-only replay scenario).
  const cookies = await context.cookies('https://blinkit.com');
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  // Location / device bits Blinkit attaches, to probe device binding later.
  // NOTE: no named inner function here — tsx/esbuild injects a `__name` helper
  // for named functions that is undefined in the browser context.
  const storage = await page.evaluate(() => {
    const keys = ['deviceId', 'auth', 'authKey', 'authKeyITS', 'gr_1_lat', 'gr_1_lon', 'gr_1_locality'];
    const out: Record<string, string | null> = {};
    for (const k of keys) {
      try {
        out[k] = localStorage.getItem(k);
      } catch {
        out[k] = null;
      }
    }
    return out;
  });

  // Decode token lifetime from wherever a JWT appears (headers + storage).
  const tokenMeta: TokenMeta[] = [];
  for (const [k, v] of Object.entries<string>(cap.headers)) {
    if (/auth|token|key|access|bearer/i.test(k)) tokenMeta.push(decodeJwtMeta(`header:${k}`, v));
  }
  for (const [k, v] of Object.entries(storage)) {
    if (/auth|token|key/i.test(k)) tokenMeta.push(decodeJwtMeta(`localStorage:${k}`, v));
  }

  const session: CapturedSession = {
    capturedAt: new Date().toISOString(),
    orderHistory: {
      url: ORDER_HISTORY_URL,
      method: cap.request.method(),
      requestHeaders: cap.headers,
      postData: cap.postData,
      responseStatus: cap.status,
    },
    cookieHeader,
    storage,
    tokenMeta,
  };

  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  console.log(`\n[ok] saved ${SESSION_FILE}`);

  console.log('\n--- token lifetime ---');
  const jwts = tokenMeta.filter((t) => t.jwt);
  if (jwts.length === 0) {
    console.log('No JWT found — the token is opaque. Lifetime can only be found');
    console.log('empirically: keep session.json and re-run `npm run replay` over days');
    console.log('until it 401s. That elapsed time is how often the user re-enters OTP.');
  } else {
    for (const t of jwts) {
      console.log(
        `${t.where}: lifetime ~${t.lifetimeHours}h, expires ${t.expiresAt}` +
          (t.claims && ('device_id' in t.claims || 'deviceId' in t.claims)
            ? '  [carries a device id claim → likely device-bound]'
            : ''),
      );
    }
  }

  console.log('\nNext: `npm run replay`  (locally first, then on the Oracle box).');
  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
