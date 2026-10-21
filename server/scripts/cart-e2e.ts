// Add to cart, end to end from the app, at phone size (design §19 stage 1).
// It signs in as a real local user, taps Add to cart on the first suggested
// item on Home, confirms, and prints what the app shows at each step.
//
// It fills that household's REAL vendor cart, so run it only on your own
// account, and check the cart in the app afterwards.
//
//   npx tsx --env-file=../.env scripts/cart-e2e.ts <email> <out-dir>
//
// Local development only: it mints a session in the local database and
// revokes it when done. Needs the stack on http://localhost:8100.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { mintSession } from '../src/auth/sessions.js';
import { createDb } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const [email, outDir] = process.argv.slice(2);
if (!email || !outDir) throw new Error('usage: cart-e2e.ts <email> <out-dir>');
const BASE = 'http://localhost:8100';
const PHONE = { width: 390, height: 844 };

const url = process.env.DATABASE_URL?.replace('@postgres:', '@127.0.0.1:').replace(':5432/', `:${process.env.POSTGRES_HOST_PORT ?? '5435'}/`);
const db = createDb(url ?? `postgres://${process.env.POSTGRES_USER}:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${process.env.POSTGRES_HOST_PORT ?? '5435'}/${process.env.POSTGRES_DB}`);
const logger = createLogger({ level: 'error' });
const { rows } = await db.query<{ id: string }>('select id from users where lower(email) = lower($1)', [email]);
if (!rows.length) throw new Error(`no local user ${email}`);
const token = await mintSession(db, logger, rows[0].id);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'dm_session', value: token, url: BASE }]);
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [console ${m.type()}] ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message.slice(0, 200)}`));
  page.on('requestfailed', (r) => console.log(`  [request failed] ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/cart/')) console.log(`  [api] ${r.request().method()} ${r.status()} ${r.url().replace(BASE, '')}`);
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // Tap "Add to cart" on the first few suggested items: each tap is instant
  // and puts the item on the cart list.
  const howMany = Number(process.argv[4] ?? 3);
  for (let i = 0; i < howMany; i++) {
    const add = page.getByRole('button', { name: /^add to cart$/i }).first();
    await add.scrollIntoViewIfNeeded();
    await add.click();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: join(outDir, 'cart-list.png') });
  console.log('list:', (await page.locator('.fixed.left-0').first().innerText()).split(String.fromCharCode(10)).filter(Boolean).join(' | '));

  // NO_SEND=1 only fills the list and shows it: nothing reaches the app.
  if (process.env.NO_SEND) {
    console.log('NO_SEND: stopping before sending.');
  } else {
  await page.getByRole('button', { name: /^send$/i }).click();
  console.log(`sending ${howMany} items…`);
  try {
    await page.getByText(/your instamart cart is ready|isn't delivering|needs connecting|went wrong/i).waitFor({ timeout: 4 * 60_000 });
  } catch {
    await page.screenshot({ path: join(outDir, 'cart-stuck.png') });
    console.log('stuck:', (await page.locator('.fixed.left-0').first().innerText()).split(String.fromCharCode(10)).filter(Boolean).join(' | '));
    throw new Error('the cart never finished');
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, 'cart-bar.png') });
  console.log('bar:', (await page.locator('.fixed.left-0').first().innerText()).split(String.fromCharCode(10)).filter(Boolean).join(' | '));

  await page.getByRole('button', { name: /^see$/i }).click();
  await page.getByRole('button', { name: /^done$/i }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, 'cart-done.png') });
  console.log('result:', (await page.locator('.fixed.bottom-0').last().innerText()).split(String.fromCharCode(10)).filter(Boolean).join(' | '));
  }
} finally {
  await browser.close();
  await db.query("delete from sessions where user_id = $1 and created_at > now() - interval '10 minutes'", [rows[0].id]);
  await db.end();
}
