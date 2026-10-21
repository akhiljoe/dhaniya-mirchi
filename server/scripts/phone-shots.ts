// Screenshots of the local site at phone size, signed in as a real local user,
// for checking a layout before calling it done (the site is built mainly for
// phones). Local development only: it mints a session for the user straight
// in the local database, and revokes it when done.
//
//   npx tsx --env-file=../.env scripts/phone-shots.ts <email> <out-dir> [view ...]
//
// Views are the app's page names (home, insights, household, how, …);
// "stock:Milk" opens that item's details on the Stock page, and
// "stock:Milk:Your products" also shoots that section, scrolled into view.
// Needs the stack running on http://localhost:8100 and the installed Chrome.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { mintSession } from '../src/auth/sessions.js';
import { createDb } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const [email, outDir, ...views] = process.argv.slice(2);
if (!email || !outDir) throw new Error('usage: phone-shots.ts <email> <out-dir> [view ...]');
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

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: 'dm_session', value: token, url: BASE }]);
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  for (const name of views.length ? views : ['home']) {
    const [view, detail, anchor] = name.split(':');
    const file = [view, detail].filter(Boolean).join('-');
    if (view !== 'home') {
      // Pages are switched in the app, not by address: through the bottom nav
      // where it has a button, else through the app's own links.
      const nav = page.locator('nav.md\\:hidden button', { hasText: new RegExp(`^${view}`, 'i') });
      if (await nav.count()) await nav.first().click();
      else if (view === 'how') await page.getByRole('button', { name: 'How it works' }).click();
      else if (view === 'household' || view === 'ai') {
        await page.getByRole('button', { name: 'Account' }).click();
        await page.getByRole('button', { name: view === 'ai' ? 'AI settings' : 'Household' }).click();
      }
      await page.waitForTimeout(800);
    }
    if (detail) {
      await page.getByText(detail, { exact: true }).first().click();
      await page.waitForTimeout(800);
    }
    await page.screenshot({ path: join(outDir, `${file}-top.png`) });
    if (anchor) {
      await page.getByText(anchor, { exact: true }).first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(outDir, `${file}-at.png`) });
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${file}-bottom.png`) });
    await page.evaluate(() => window.scrollTo(0, 0));
    // The whole page, for sections between the top and the bottom.
    await page.screenshot({ path: join(outDir, `${file}-full.png`), fullPage: true });
  }
} finally {
  await browser.close();
  await db.query('delete from sessions where user_id = $1 and created_at > now() - interval \'10 minutes\'', [rows[0].id]);
  await db.end();
}
