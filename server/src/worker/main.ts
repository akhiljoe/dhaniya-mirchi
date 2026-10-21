// The worker service entry point (design §7.10, §11).
//
//   node dist/worker/main.js          run: keep a heartbeat so the api can
//                                     report the worker alive
//   node dist/worker/main.js probe    go/no-go: can this browser, from this
//                                     machine's IP, load the vendor sites?
//   node dist/worker/main.js announce --title "…" --body "…" [--push] [--dry-run]
//                                     tell every user something (design §13.3);
//                                     only the operator runs it, never a release
//   node dist/worker/main.js feedback [--days N]
//   node dist/worker/main.js cart-show <household-id>   read-only: what the
//                                     worker sees in that household's vendor cart
//   node dist/worker/main.js order-dry-run <household-id> [--phone 1234] [--add "milk"]
//                                     walk the checkout as far as it goes
//                                     without buying anything, and say what
//                                     this account can pay with (design 19
//                                     stage 2). It never places an order.
//   node dist/worker/main.js blinkit-dry-run <household-id> [--phone 1234]
//                                     [--address <id>] [--add "milk" --add "eggs"]
//                                     the same walk on Blinkit, which CAN go
//                                     the whole way because nothing is created
//                                     until the money moves. It fills a real
//                                     cart (the worker's own, not the phone's)
//                                     and empties it again. It never pays.
//                                     print what users sent from the footer
//
// The probe is the check to run first on any new host (the Oracle VM's
// datacenter IP is the open question, design §14.1): a vendor that blocks the
// browser answers the page load itself with 403.
import { loadConfig } from '../config.js';
import { CART_VENDORS, CONNECTABLE_VENDORS, ORDER_HARD_CAP_RUPEES, FEEDBACK_DEFAULT_DAYS, PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_MS, PROBE_TARGETS, WORKER_HEARTBEAT_MS } from '../constants.js';
import { createDb } from '../db.js';
import { createLogger, errorFields } from '../logger.js';
import { blinkitAdapter } from './adapters/blinkit.js';
import { blinkitImportAdapter } from './adapters/blinkit-import.js';
import { instamartAdapter } from './adapters/instamart.js';
import { orderDryRun } from './order.js';
import { blinkitDryRun } from './blinkit-order.js';
import { instamartImportAdapter } from './adapters/instamart-import.js';
import { zeptoAdapter } from './adapters/zepto.js';
import { zeptoImportAdapter } from './adapters/zepto-import.js';
import { instamartCartAdapter } from './adapters/instamart-cart.js';
import { blinkitPageAdapter } from './adapters/blinkit-page.js';
import { describeCart, startCartLoop } from './cart.js';
import { startPayLoop } from './pay.js';
import { LiveCarts } from './live-carts.js';
import { closeWarmBrowser } from './warm-browser.js';
import { queueDueSyncs, queueImport, runImport, type ImportAdapters } from './import/import.js';
import { startImportLoop } from './import/import-loop.js';
import { allowanceProvider, startAiLoop } from './ai.js';
import { announce, deliverAnnouncements, parseAnnounceArgs } from './announce.js';
import { sendCartNotices, sendImportNotices, sendOrderNotices, webPushSender } from './notify.js';
import type { JobLoop } from './job-loop.js';
import { launchHeadless } from './chrome.js';
import { startConnectLoop, type ConnectLoop } from './connect-loop.js';
import { recordHeartbeat } from './status.js';

// Every vendor whose history can be read. One list for the import loop and
// `relist`: the two kept a copy each, and relist's never learned Zepto, so it
// failed every Zepto connection as `internal`.
function importAdapters(): ImportAdapters {
  return { instamart: instamartImportAdapter(), blinkit: blinkitImportAdapter(), zepto: zeptoImportAdapter() };
}

async function probe(): Promise<number> {
  const logger = createLogger({ level: 'info', service: 'worker-probe' });
  const hb = await launchHeadless();
  let failures = 0;
  try {
    logger.info('browser', { version: hb.version, userAgent: hb.userAgent });
    const context = hb.browser.contexts()[0] ?? (await hb.browser.newContext());
    for (const t of PROBE_TARGETS) {
      const page = await context.newPage();
      try {
        const res = await page.goto(t.url, { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS });
        await page.waitForTimeout(PAGE_SETTLE_MS);
        const status = res?.status() ?? 0;
        const webdriver = await page.evaluate('navigator.webdriver');
        const text = String(await page.evaluate('document.body.innerText.slice(0, 100)')).replace(/\s+/g, ' ');
        // 2xx: Zepto's first answer is a 202, AWS WAF's challenge that the
        // page then solves by itself. A block is a 403.
        const pass = status >= 200 && status < 300;
        if (!pass) failures++;
        logger.info(pass ? 'PASS' : 'FAIL', { vendor: t.vendor, status, webdriver, page: text });
      } catch (err) {
        failures++;
        logger.error('FAIL', { vendor: t.vendor, ...errorFields(err) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await hb.close();
  }
  return failures === 0 ? 0 : 1;
}

async function run(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, production: config.production, service: 'worker' });
  const db = createDb(config.databaseUrl);

  // Prove the browser starts before claiming to be alive, and report which one.
  const hb = await launchHeadless();
  const chromeVersion = hb.version;
  await hb.close();
  logger.info('worker ready', { chromeVersion });

  const beat = () =>
    recordHeartbeat(db, { chromeVersion }).catch((err) => logger.warn('heartbeat failed', errorFields(err)));
  await beat();
  const timer = setInterval(beat, WORKER_HEARTBEAT_MS);

  // Connecting grocery apps needs the vault private key (only the worker has it).
  let connect: ConnectLoop | null = null;
  let imports: JobLoop | null = null;
  let carts: JobLoop | null = null;
  let paying: JobLoop | null = null;
  let liveCarts: LiveCarts | null = null;
  if (config.vault.publicKey && config.vault.privateKeys.length) {
    connect = await startConnectLoop(
      { db, logger, vault: config.vault, adapters: { instamart: instamartAdapter(), blinkit: blinkitAdapter(), zepto: zeptoAdapter() } },
      config.databaseUrl,
    );
    logger.info('connect loop running', { vendors: [...CONNECTABLE_VENDORS] });
    // "Your history is in" notices need the VAPID private key (design §13.1).
    const sender = config.push.privateKey ? webPushSender(config.push) : null;
    imports = await startImportLoop(
      { db, logger, vault: config.vault, adapters: importAdapters() },
      config.databaseUrl,
      // Isolated: a notice failing never stops imports from being claimed.
      {
        onSweep: sender
          ? async () => {
              await queueDueSyncs(db).catch((err) => logger.warn('sync: scheduling failed', errorFields(err)));
              await sendImportNotices({ db, logger, sender }).catch((err) => logger.warn('notify: sweep failed', errorFields(err)));
              await sendCartNotices({ db, logger, sender }).catch((err) => logger.warn('notify: cart sweep failed', errorFields(err)));
              await sendOrderNotices({ db, logger, sender }).catch((err) => logger.warn('notify: order sweep failed', errorFields(err)));
              await deliverAnnouncements({ db, logger, sender }).catch((err) => logger.warn('announce: sweep failed', errorFields(err)));
            }
          : () => queueDueSyncs(db).catch((err) => logger.warn('sync: scheduling failed', errorFields(err))),
      },
    );
    logger.info('import loop running', { vendors: [...CONNECTABLE_VENDORS], notifications: sender ? 'on' : 'off' });

    // Putting items in a household's own vendor cart (design §19 stage 1).
    // Shared by the two loops below, which is the whole point: the browser
    // the cart loop fills a cart in is the browser the pay loop pays in. On
    // Blinkit the cart exists nowhere else, so without this every payment
    // rebuilds the cart the household just watched being built.
    liveCarts = new LiveCarts(logger);

    carts = await startCartLoop(
      { db, logger, vault: config.vault, adapters: { instamart: instamartCartAdapter(), blinkit: blinkitPageAdapter() }, liveCarts },
      config.databaseUrl,
    );
    logger.info('cart loop running', { vendors: [...CART_VENDORS] });

    // Paying for a cart the household asked to be paid for (design §19
    // stages 2-3). Nothing here starts on its own: every order in this loop
    // was put there by somebody tapping.
    paying = await startPayLoop(
      { db, logger, vault: config.vault, adapters: { instamart: instamartCartAdapter(), blinkit: blinkitPageAdapter() }, liveCarts },
      config.databaseUrl,
    );
    logger.info('pay loop running', { cap: ORDER_HARD_CAP_RUPEES });
  } else {
    logger.warn('vault keys missing — connecting grocery apps is disabled (see .env.example)');
  }

  // Reading households' words into facts (design §7.8). A household's own key
  // needs the vault; our allowance needs LLM_PROVIDER and its key.
  const ai = await startAiLoop({ db, logger, vault: config.vault, ai: config.ai }, config.databaseUrl);
  const allowance = allowanceProvider(config.ai);
  logger.info('ai loop running', {
    enabled: config.ai.enabled,
    allowance: config.ai.enabled && allowance ? `${allowance.name} ${allowance.model}` : 'off',
    ownKeys: config.ai.enabled && config.vault.privateKeys.length ? 'on' : 'off',
  });
  if (config.ai.provider !== 'off' && !allowance) logger.warn(`LLM_PROVIDER=${config.ai.provider} but its API key is missing — the free allowance is off`);

  const shutdown = async (signal: string) => {
    logger.info('worker shutting down', { signal });
    clearInterval(timer);
    await Promise.all([
      connect?.stop().catch((err) => logger.error('connect loop stop failed', errorFields(err))),
      imports?.stop().catch((err) => logger.error('import loop stop failed', errorFields(err))),
      carts?.stop().catch((err) => logger.error('cart loop stop failed', errorFields(err))),
      paying?.stop().catch((err) => logger.error('pay loop stop failed', errorFields(err))),
      // A headless Chrome that outlives the worker is a signed-in browser
      // nobody is watching.
      liveCarts?.closeAll().catch((err) => logger.error('parked browsers close failed', errorFields(err))),
      closeWarmBrowser().catch((err) => logger.error('warm browser close failed', errorFields(err))),
      ai.stop().catch((err) => logger.error('ai loop stop failed', errorFields(err))),
    ]);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// The operator's announcement (design §13.3). Prints who it reaches.
// Read a connection's whole history again, pages with nothing new included.
// For a vendor whose pack labels live only in its order pages (Blinkit), a
// job that stopped before the packs step leaves packs unknown, and an
// ordinary sync stops at the first page it has already seen - so those packs
// are never learned. This is the way to fill them, and it costs one call per
// order: only run it when asked.
//
//   docker compose run --rm worker node dist/worker/main.js relist <connection-id>
async function runRelist(argv: string[]): Promise<number> {
  const connectionId = argv[3];
  if (!connectionId) throw new Error('usage: relist <connection-id>');
  const config = loadConfig();
  if (!config.vault.privateKeys.length) throw new Error('relist needs the vault keys');
  const db = createDb(config.databaseUrl);
  const logger = createLogger({ level: config.logLevel, production: config.production, service: 'worker-relist' });
  try {
    const jobId = await queueImport(db, connectionId);
    // Claim it the way the worker's own loop does. Without this both this
    // command and the running worker hold the same job: two headless browsers
    // on one account, double the request rate, and Blinkit's edge answers
    // that with a challenge page.
    const claimed = await db.query(
      `update import_jobs set status = 'listing', updated_at = now() where id = $1 and status = 'queued' returning id`,
      [jobId],
    );
    if (!claimed.rowCount) {
      console.log('That connection already has an import running; let it finish, then relist.');
      return 1;
    }
    const deps = {
      db,
      logger,
      vault: config.vault,
      adapters: importAdapters(),
      relistAll: true,
    };
    await runImport(deps, jobId);
    const { rows } = await db.query<{ status: string; orders_done: number }>(
      `select status, orders_done from import_jobs where id = $1`,
      [jobId],
    );
    const { rows: packs } = await db.query<{ known: string; unknown: string }>(
      `select count(*) filter (where label is not null) as known,
              count(*) filter (where label is null) as unknown
         from sku_packs where vendor = (select vendor from vendor_connections where id = $1)`,
      [connectionId],
    );
    console.log(`relist ${rows[0]?.status}: ${rows[0]?.orders_done} orders read, packs known ${packs[0]?.known}, still unknown ${packs[0]?.unknown}.`);
    return rows[0]?.status === 'complete' ? 0 : 1;
  } finally {
    await db.end();
  }
}

async function runAnnounce(argv: string[]): Promise<number> {
  const args = parseAnnounceArgs(argv);
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const r = await announce(db, args);
    const reach = `${r.users} users see it under the bell${args.push ? `; ${r.pushUsers} also ${r.pushUsers === 1 ? 'gets' : 'get'} a push${config.push.privateKey ? '' : ' (not sent: web push is not configured)'}` : ''}`;
    console.log(args.dryRun ? `Dry run, nothing stored. ${reach}.` : `Stored announcement ${r.id}. ${reach}.`);
    return 0;
  } finally {
    await db.end();
  }
}

// What users sent from the footer (design §12.8), newest first.
async function runFeedback(argv: string[]): Promise<number> {
  const i = argv.indexOf('--days');
  const days = i >= 0 ? Number(argv[i + 1]) : FEEDBACK_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) throw new Error('usage: feedback [--days N]');
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const { rows } = await db.query<{ created_at: Date; email: string | null; page: string | null; message: string }>(
      `select f.created_at, u.email, f.page, f.message from feedback f left join users u on u.id = f.user_id
        where f.created_at > now() - make_interval(days => $1) order by f.created_at desc`,
      [days],
    );
    if (!rows.length) console.log(`No feedback in the last ${days} days.`);
    for (const r of rows) console.log(`
${r.created_at.toISOString()} · ${r.email ?? 'deleted user'}${r.page ? ` · on ${r.page}` : ''}
${r.message}`);
    return 0;
  } finally {
    await db.end();
  }
}

if (process.argv[2] === 'feedback') {
  runFeedback(process.argv.slice(3))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (process.argv[2] === 'announce') {
  runAnnounce(process.argv.slice(3))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (process.argv[2] === 'cart-show') {
  // Read-only: what the worker sees in a household's cart (design §19 stage 1).
  (async () => {
    const config = loadConfig();
    const logger = createLogger({ level: 'info', service: 'worker-cart-show' });
    const db = createDb(config.databaseUrl);
    try {
      await describeCart({ db, logger, vault: config.vault, adapters: { instamart: instamartCartAdapter() } }, process.argv[3]);
    } finally {
      await db.end();
    }
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (process.argv[2] === 'order-dry-run') {
  // Walks the real checkout and stops one step short of the call that would
  // create an order. Nothing is bought and no money moves (worker/order.ts).
  (async () => {
    const config = loadConfig();
    const logger = createLogger({ level: 'info', service: 'worker-order-dry-run' });
    const db = createDb(config.databaseUrl);
    const flag = (name: string) => {
      const i = process.argv.indexOf(name);
      return i > 0 ? process.argv[i + 1] : undefined;
    };
    try {
      return await orderDryRun(
        { db, logger, vault: config.vault, adapters: { instamart: instamartCartAdapter() } },
        { householdId: process.argv[3], phoneLast4: flag('--phone'), add: flag('--add') },
      );
    } finally {
      await db.end();
    }
  })()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (process.argv[2] === 'blinkit-dry-run') {
  // Walks Blinkit's whole chain and stops where money starts. Unlike
  // Instamart, nothing is created before the payment, so the last call can be
  // made and still owe nobody anything (worker/blinkit-order.ts).
  //
  // It DOES replace the worker's own cart on that account - this vendor has
  // no read-only look - and empties it again afterwards.
  (async () => {
    const config = loadConfig();
    const logger = createLogger({ level: 'info', service: 'worker-blinkit-dry-run' });
    if (!config.vault.privateKeys.length) throw new Error('blinkit-dry-run needs the vault keys');
    const db = createDb(config.databaseUrl);
    const flag = (name: string) => {
      const i = process.argv.indexOf(name);
      return i > 0 ? process.argv[i + 1] : undefined;
    };
    // Repeatable: one --add per thing to put in the cart.
    const add = process.argv.reduce<string[]>((out, a, i) => (a === '--add' && process.argv[i + 1] ? [...out, process.argv[i + 1]] : out), []);
    try {
      return await blinkitDryRun(
        { db, logger, vault: config.vault },
        { householdId: process.argv[3], phoneLast4: flag('--phone'), addressId: flag('--address'), add },
      );
    } finally {
      await db.end();
    }
  })()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (process.argv[2] === 'relist') {
  runRelist(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else if (process.argv[2] === 'probe') {
  probe()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

