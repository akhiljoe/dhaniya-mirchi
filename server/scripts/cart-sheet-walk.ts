// Walk the cart sheet the way a household does, and say what it did.
//
//   npx tsx --env-file=../.env scripts/cart-sheet-walk.ts <email> <out-dir>
//
// Adds two things from Supplies, opens the sheet, takes them off one by one,
// and does the same on any cart tab there is - screenshotting each step and
// checking that an emptied tab GOES rather than lingering with a button to
// confirm it. Written after the sheet had done exactly that ("Everything
// taken off. Remove this cart. Undo." - "It should just clear right").
//
// Local development only, like phone-shots.ts: a session is minted for the
// user straight in the local database and revoked afterwards. Nothing is
// sent to any store and nothing is paid for - Send and Pay are never pressed.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Page } from 'playwright-core';

import { mintSession } from '../src/auth/sessions.js';
import { createDb } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const [email, outDir] = process.argv.slice(2);
if (!email || !outDir) throw new Error('usage: cart-sheet-walk.ts <email> <out-dir>');
const BASE = 'http://localhost:8100';
const PHONE = { width: 390, height: 844 };

const url = process.env.DATABASE_URL?.replace('@postgres:', '@127.0.0.1:').replace(':5432/', `:${process.env.POSTGRES_HOST_PORT ?? '5435'}/`);
const db = createDb(url ?? `postgres://${process.env.POSTGRES_USER}:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${process.env.POSTGRES_HOST_PORT ?? '5435'}/${process.env.POSTGRES_DB}`);
const logger = createLogger({ level: 'error' });

const { rows } = await db.query<{ id: string }>('select id from users where lower(email) = lower($1)', [email]);
if (!rows.length) throw new Error(`no local user ${email}`);
const token = await mintSession(db, logger, rows[0].id);
if (!token) throw new Error('could not mint a session');
mkdirSync(outDir, { recursive: true });

let step = 0;
const shot = async (page: Page, what: string) => {
  step += 1;
  const file = `${String(step).padStart(2, '0')}-${what}.png`;
  await page.screenshot({ path: join(outDir, file) });
  console.log(`  ${file}`);
};
const sheetOpen = (page: Page) => page.locator('[role="dialog"]').count().then((n) => n > 0);
const tabNames = async (page: Page) =>
  (await page.locator('[role="dialog"] [aria-pressed]').allInnerTexts()).map((t) => t.split('\n')[0].trim()).filter(Boolean);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems: string[] = [];
try {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'dm_session', value: token, url: BASE }]);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // A clean list to start from, whatever the app made up on arrival.
  await page.evaluate(() => window.localStorage.setItem('dm_basket', '[]'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // Two things from the rows.
  const adds = page.getByRole('button', { name: /^Add .* to the list$/ });
  const n = Math.min(await adds.count(), 2);
  for (let i = 0; i < n; i++) {
    await adds.first().click(); // the first plus becomes a stepper, so the next plus is first again
    await page.waitForTimeout(300);
  }
  console.log(`added ${n} from the rows`);
  await shot(page, 'added');

  // The line, and the sheet behind it.
  const line = page.locator('button', { hasText: /\d+ things?/ }).first();
  if (!(await line.count())) problems.push('no cart line after adding');
  await line.click();
  await page.waitForTimeout(600);
  if (!(await sheetOpen(page))) problems.push('the sheet did not open from the line');
  await shot(page, 'sheet');
  console.log(`tabs: ${(await tabNames(page)).join(' | ') || '(one tab, no strip)'}`);

  // Off, one at a time, on the list.
  for (let i = 0; i < 10; i++) {
    const bins = page.locator('[role="dialog"] button[aria-label^="Remove "]');
    if (!(await bins.count())) break;
    await bins.first().click();
    await page.waitForTimeout(400);
    await shot(page, `list-removed-${i + 1}`);
  }
  console.log(`after emptying the list: sheet open ${await sheetOpen(page)}`);
  // The tab that emptied was the open one, so the sheet should have closed
  // rather than handing over the next tab - and its bin.
  if (await sheetOpen(page)) problems.push('the sheet stayed open on another tab after the list emptied');

  // A cart tab, if there is one: open the sheet again from the line, take
  // everything off the cart, and see that it goes.
  const again = page.locator('button', { hasText: /cart ready|carts ready/ }).first();
  if (await again.count()) {
    await again.click();
    await page.waitForTimeout(600);
    await shot(page, 'reopened');
  }
  if (await sheetOpen(page)) {
    const cartTab = page.locator('[role="dialog"] [aria-pressed]', { hasText: /in · ₹|in$/ }).first();
    if (await cartTab.count()) {
      const name = (await cartTab.innerText()).split('\n')[0];
      await cartTab.click();
      await page.waitForTimeout(400);
      await shot(page, `cart-${name}`);
      for (let i = 0; i < 10; i++) {
        const bins = page.locator('[role="dialog"] button[aria-label^="Remove "]');
        if (!(await bins.count())) break;
        await bins.first().click();
        await page.waitForTimeout(500);
        await shot(page, `cart-${name}-removed-${i + 1}`);
      }
      const still = (await sheetOpen(page)) ? await tabNames(page) : [];
      console.log(`after emptying ${name}: sheet open ${await sheetOpen(page)}; tabs: ${still.join(' | ') || '(none)'}`);
      if (still.includes(name)) problems.push(`the emptied ${name} cart still had a tab`);
      const said = (await sheetOpen(page)) ? await page.locator('[role="dialog"]').innerText() : '';
      if (/taken off|Remove this cart/i.test(said)) problems.push('the sheet asked to confirm an already-empty cart');
    } else {
      console.log('no cart tab to empty (no ready cart in the last six hours)');
    }
  }

  await shot(page, 'end');
} finally {
  await browser.close();
  await db.query("delete from sessions where user_id = $1 and created_at > now() - interval '10 minutes'", [rows[0].id]);
  await db.end();
}

if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nno problems: emptied tabs went, the sheet followed');
