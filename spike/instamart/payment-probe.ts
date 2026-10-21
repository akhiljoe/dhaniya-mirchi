// What can this account pay with? READ ONLY: it asks the checkout what it
// offers and prints the answer. It places nothing, pays nothing, and touches
// no cart. Design §19 stage 2.
//
// The recorded checkout (2026-09-21) showed the chain starts
// POST /api/v3/payment/get-payment-options, but that recording held the
// delivery address and the card's token and was deleted, so the request's
// own shape is not known here. This tries the shapes that are plausible and
// prints the status of each, with the body scrubbed of anything card-shaped.
//
//   docker compose exec -T worker node dist/spike-payment-probe.js   (no)
//   npx tsx --env-file=.env spike/instamart/payment-probe.ts <phoneLast4>
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import { launchHeadless } from '../../server/src/worker/chrome.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { INSTAMART_ORIGIN } from '../../server/src/constants.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PHONE_LAST4 = process.argv[2] ?? '4567';

// A card's digits should never appear (the vendor holds cards as tokens), but
// a probe's output is not the place to find that out the hard way.
function scrub(text: string): string {
  return text.replace(/(?:\d[ -]*?){13,19}/g, '[card-number-removed]').replace(/("(?:cvv|cvc|card_number|cardNumber|pan)"\s*:\s*)"[^"]*"/gi, '$1"[removed]"');
}

async function main() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const { rows } = await db.query<{ id: string; session_sealed: string }>(
    `select id, session_sealed from vendor_connections where vendor = 'instamart' and phone_last4 = $1 order by created_at limit 1`,
    [PHONE_LAST4],
  );
  if (!rows.length) throw new Error(`no Instamart connection ending ${PHONE_LAST4}`);
  const conn = rows[0]!;
  const session = JSON.parse(openSealed(config.vault.privateKeys, conn.session_sealed, `vendor_connections:${conn.id}:session`)) as CapturedSession;
  await db.end();

  const hb = await launchHeadless(CHROME, process.env.CHROME_VERSION);
  try {
    const context = await hb.browser.newContext({ userAgent: hb.userAgent });
    await context.addCookies(
      session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
      })),
    );
    await context.addInitScript(
      `if (location.origin === ${JSON.stringify(INSTAMART_ORIGIN)}) {
         const s = ${JSON.stringify(session.localStorage)};
         for (const k of Object.keys(s)) localStorage.setItem(k, s[k]);
       }`,
    );
    const page = await context.newPage();
    await page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(4000);

    const tries: { method: 'GET' | 'POST'; path: string; body: unknown }[] = [
      { method: 'POST', path: '/api/v3/payment/get-payment-options', body: {} },
      { method: 'GET', path: '/api/v3/payment/get-payment-options', body: null },
      { method: 'POST', path: '/api/v3/payment/get-payment-options', body: { cartType: 'INSTAMART' } },
      { method: 'POST', path: '/api/v3/payment/get-payment-options?cartType=INSTAMART', body: {} },
      { method: 'POST', path: '/api/instamart/payment/get-payment-options', body: {} },
    ];
    // What the page itself gets when it opens the cart. Opening a page places
    // no order: the recorded checkout (design §19) only calls
    // POST /api/v3/instamart/checkout/order after a method is chosen and Pay
    // is pressed. Nothing here is clicked.
    const seen: { url: string; status: number; body: string }[] = [];
    page.on('response', async (r) => {
      const u = r.url();
      if (!/payment|checkout|juspay/i.test(u)) return;
      let body = '';
      try {
        const ct = (await r.headerValue('content-type')) ?? '';
        if (/json/i.test(ct)) body = (await r.text()).slice(0, 600);
      } catch {
        body = '';
      }
      seen.push({ url: u, status: r.status(), body });
      // The payment options in full, as the page's own call was answered:
      // the shape the adapter has to read (design §19 stage 2). Keys and the
      // words the page shows, never a token or a card's digits.
      if (/get-payment-options/.test(u)) {
        try {
          const json = JSON.parse((await r.text()) || '{}');
          const walk = (v: unknown, path: string, depth: number): void => {
            if (depth > 6 || v === null) return;
            if (Array.isArray(v)) return v.slice(0, 3).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
            if (typeof v === 'object') {
              for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
                if (/token|auth|card|pan|vpa|mobile|email|phone|id$/i.test(k)) {
                  console.log(`    ${path}.${k} = <hidden ${typeof x}>`);
                  continue;
                }
                walk(x, `${path}.${k}`, depth + 1);
              }
              return;
            }
            if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length < 40)) console.log(`    ${path} = ${JSON.stringify(v)}`);
          };
          // The question that decides whether an unattended payment is even
          // on offer: does this account's checkout carry a mandate, an
          // autopay or a one-click flag, and which UPI shapes are allowed?
          const text = await r.text();
          const hits = new Map<string, number>();
          for (const m of text.matchAll(/"([A-Za-z_0-9]*(?:mandate|autopay|auto_pay|recurring|standing|one_?click|cvv|cvvLess|skip|frictionless|si_|subscription|upi[A-Za-z_]*)[A-Za-z_0-9]*)"\s*:\s*([^,}\]]{0,40})/gi)) {
            hits.set(`${m[1]} = ${m[2].trim().slice(0, 36)}`, (hits.get(`${m[1]} = ${m[2].trim().slice(0, 36)}`) ?? 0) + 1);
          }
          console.log('  --- flags that decide unattended payment ---');
          for (const [k, n] of [...hits].sort()) console.log(`    ${k}${n > 1 ? `   (x${n})` : ''}`);
          console.log('  --- the groups offered ---');
          for (const m of text.matchAll(/"(?:group_name|display_name|payment_method_type|paymentMethodType)"\s*:\s*"([^"]{1,40})"/g)) hits.set(`group:${m[1]}`, 1);
          console.log(`    ${[...hits.keys()].filter((k) => k.startsWith('group:')).map((k) => k.slice(6)).join(' | ')}`);
          console.log('  --- end ---');
        } catch {
          console.log('  (payment options body was not JSON)');
        }
      }
    });
    for (const path of ['/cart', '/checkout', '/checkout/cart', '/instamart/checkout']) {
      seen.length = 0;
      const res = await page.goto(`${INSTAMART_ORIGIN}${path}`, { waitUntil: 'load', timeout: 60_000 }).catch(() => null);
      await page.waitForTimeout(6000);
      console.log(`
=== the page at ${path} -> ${res?.status() ?? 'no answer'} (now ${page.url()}) ===`);
      for (const r of seen) console.log(`  ${r.status} ${r.url.slice(0, 120)}
      ${scrub(r.body).slice(0, 260).replace(/\s+/g, ' ')}`);
      const words = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return t
          .split(String.fromCharCode(10))
          .map((l) => l.trim())
          .filter((l) => /pay|card|wallet|banking|upi|delivery/i.test(l))
          .slice(0, 25);
      });
      console.log(`  page says: ${JSON.stringify(words)}`);
    }
    await page.goto(`${INSTAMART_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(2000);

    for (const t of tries) {
      const args = JSON.stringify({ path: t.path, method: t.method, body: t.body === null ? null : JSON.stringify(t.body) });
      const r = (await page.evaluate(`(async () => {
        const a = ${args};
        const r = await fetch(a.path, {
          method: a.method,
          credentials: 'include',
          headers: a.body ? { 'content-type': 'application/json' } : {},
          body: a.body,
        });
        return { status: r.status, body: await r.text() };
      })()`)) as { status: number; body: string };
      console.log(`\n${t.method} ${t.path} ${t.body === null ? '' : JSON.stringify(t.body)} -> ${r.status} (${r.body.length} bytes)`);
      console.log(`  ${scrub(r.body).slice(0, 400).replace(/\s+/g, ' ')}`);
    }
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
