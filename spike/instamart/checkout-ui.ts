// The controls the worker will have to drive to pay (design §19 stage 3,
// manual relay first): what is on the payment screen, what the saved card's
// row looks like, and where the CVV is typed.
//
// SAFETY, three layers, because this walk goes further than any other here:
//
//   1. Every request to the order call is ABORTED at the browser. The
//      recorded chain creates the order at POST .../checkout/order, before
//      any money moves, so blocking it means no order can exist however this
//      script or a mis-tap behaves. Juspay and the bank are blocked too.
//   2. Nothing that says Pay is ever tapped. Only "Proceed to Pay" (which
//      opens the payment screen) and the saved card's row (which reveals the
//      CVV box) are touched.
//   3. No CVV and no OTP is typed. This script cannot: it is never given one.
//
// It prints selectors and the words on screen, never a card's digits or a
// token.
//
//   npx tsx --env-file=.env spike/instamart/checkout-ui.ts [phoneLast4]
import { loadConfig } from '../../server/src/config.js';
import { createDb } from '../../server/src/db.js';
import { openSealed } from '../../server/src/vault.js';
import { launchHeadless } from '../../server/src/worker/chrome.js';
import type { CapturedSession } from '../../server/src/worker/connect.js';
import { INSTAMART_ORIGIN } from '../../server/src/constants.js';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PHONE_LAST4 = process.argv[2] ?? '4567';

// Anything that could create an order or start a payment. Blocked outright.
// Not the Juspay AUTH TOKEN call: that one moves no money and the payment
// screen will not render without it (blocking it blanked the screen on the
// first run). The calls that matter are the order, the transaction and the
// bank's own pages.
const NEVER = /checkout\/order|api\.juspay\.in|\/txns|pay\/start|paytm|wibmo|3ds2/i;

interface Control {
  tag: string;
  text: string;
  testId: string | null;
  role: string | null;
  clickable: boolean;
}

function mask(s: string): string {
  return s.replace(/\d{4,}/g, (d) => `${'X'.repeat(d.length - 4)}${d.slice(-4)}`);
}

async function controls(page: import('playwright-core').Page): Promise<Control[]> {
  return page.evaluate(() => {
    const out: { tag: string; text: string; testId: string | null; role: string | null; clickable: boolean }[] = [];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], [data-testid], input, label, a'));
    for (const el of nodes.slice(0, 120)) {
      const text = (el as HTMLElement).innerText?.trim().slice(0, 60) ?? '';
      const testId = el.getAttribute('data-testid');
      if (!text && !testId) continue;
      // The cart page's "you might also like" rail is 100 rows of product
      // buttons and none of it is a control this walk cares about.
      if (testId && /^(item|increment-button|add-btn|buttonpair|offer-text|line)/.test(testId)) continue;
      const box = (el as HTMLElement).getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        text: text.replace(/\s+/g, ' '),
        testId,
        role: el.getAttribute('role'),
        clickable: box.width > 0 && box.height > 0,
      });
    }
    return out;
  });
}

function show(title: string, found: Control[]): void {
  console.log(`\n--- ${title} (${found.length}) ---`);
  for (const c of found.filter((c) => c.clickable)) {
    console.log(`  <${c.tag}>${c.testId ? ` [data-testid="${c.testId}"]` : ''}${c.role ? ` role=${c.role}` : ''}  ${mask(c.text) || '(no text)'}`);
  }
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
    // Layer 1: nothing that creates an order or starts a payment leaves the
    // browser, whatever happens below.
    let blocked = 0;
    await context.route('**/*', (route) => {
      if (NEVER.test(route.request().url())) {
        blocked++;
        console.log(`  [blocked] ${route.request().method()} ${route.request().url().slice(0, 90)}`);
        return route.abort();
      }
      return route.continue();
    });
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
    await page.goto(`${INSTAMART_ORIGIN}/cart`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(6000);
    show('the cart page', await controls(page));

    // Opening the payment screen. This does not create an order: the recorded
    // chain reaches checkout/order only after a method is chosen and Pay is
    // pressed - and that call is blocked above regardless.
    const proceed = page.getByText(/proceed to pay/i).first();
    if (!(await proceed.count())) {
      console.log('\nNo "Proceed to Pay" on the cart. Put something in the cart and run again.');
      return;
    }
    await proceed.click({ timeout: 15_000 }).catch((e) => console.log(`  (could not tap Proceed to Pay: ${e.message.slice(0, 80)})`));
    await page.waitForTimeout(6000);
    console.log(`\nnow at ${page.url()}`);
    const screen = await controls(page);
    show('the payment screen', screen);

    // Which card rows already show a CVV box, BEFORE anything is tapped. The
    // worker assumed none did and tapped the tick to reveal one; if the
    // preferred row already has its box open, that tap closes it instead, and
    // the CVV has nowhere to go (seen live 2026-09-22: `no_cvv_box`).
    // Written as a plain string on purpose: tsx names inner arrow
    // functions, and the helper it adds (__name) does not exist inside
    // the page.
    const rows = async () =>
      (await page.evaluate(`(() => Array.from(document.querySelectorAll('[data-testid=\"pm_card_container\"]')).map(function (row) { var box = row.querySelector('[data-testid=\"pm_card_cvv\"]'); var pay = row.querySelector('[data-testid=\"pm_card_pay_btn\"]'); var tick = row.querySelector('[data-testid=\"pm_card_tick\"]'); var nameEl = row.querySelector('[data-testid=\"pm_card_name\"]'); return { name: nameEl ? nameEl.innerText.replace(/\\s+/g, ' ').trim() : '?', hasCvvBox: !!box && box.getBoundingClientRect().width > 0, cvvMaxLength: box ? box.maxLength : null, cvvPlaceholder: box ? box.getAttribute('placeholder') : null, hasPayButton: !!pay && pay.getBoundingClientRect().width > 0, tick: tick ? (tick.getAttribute('aria-checked') || tick.getAttribute('data-checked') || String(tick.className).slice(0, 50)) : '(no tick)' }; }))()`)) as { name: string; hasCvvBox: boolean; cvvMaxLength: number | null; cvvPlaceholder: string | null; hasPayButton: boolean; tick: string }[];

    console.log('\n--- the card rows, before anything is tapped ---');
    for (const r of await rows()) console.log(`  ${JSON.stringify(r)}`);

    // Tap the FIRST row's tick, exactly as the worker does, and look again.
    const tick = page.locator('[data-testid="pm_card_container"]').first().locator('[data-testid="pm_card_tick"]').first();
    if (await tick.count()) {
      await tick.click({ timeout: 10_000 }).catch((e) => console.log(`  (could not tap the tick: ${e.message.slice(0, 80)})`));
      await page.waitForTimeout(3000);
      console.log('\n--- after tapping the first card_s tick, as the worker does ---');
      for (const r of await rows()) console.log(`  ${JSON.stringify(r)}`);
    }

    // And tap the SECOND row, the one that is not preferred: does its own CVV
    // box appear.
    const second = page.locator('[data-testid="pm_card_container"]').nth(1);
    if (await second.count()) {
      await second.locator('[data-testid="pm_card_tick"]').first().click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(3000);
      console.log('\n--- after tapping the second card_s tick ---');
      for (const r of await rows()) console.log(`  ${JSON.stringify(r)}`);
    }

    const boxes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map((i) => ({
        type: i.getAttribute('type'),
        name: i.getAttribute('name'),
        id: i.getAttribute('id'),
        testId: i.getAttribute('data-testid'),
        placeholder: i.getAttribute('placeholder'),
        maxLength: i.maxLength,
        inputMode: i.getAttribute('inputmode'),
      }));
    });
    console.log('\n--- every box that can be typed into ---');
    for (const b of boxes) console.log(`  ${JSON.stringify(b)}`);

    console.log(`\n${blocked} request(s) to the order or payment chain were blocked. No order was created and no money moved.`);
  } finally {
    await hb.close();
  }
}

main().catch((e) => {
  console.error('[fail]', e);
  process.exit(1);
});
