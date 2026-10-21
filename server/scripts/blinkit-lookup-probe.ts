// How fast can the store answer "do you sell this, and have you got any?"
//
//   cd server
//   npx tsx --env-file=../.env scripts/blinkit-lookup-probe.ts
//
// Read-only. It asks the store's own search api and prints what it says about
// each of the household's usual names, with a time. Nothing is added to any
// cart and no order can come out of this.
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { openSealed } from '../src/vault.js';
import { blinkitPageAdapter } from '../src/worker/adapters/blinkit-page.js';
import { readStoredAddresses } from '../src/worker/adapters/blinkit.js';
import { launchHeadless } from '../src/worker/chrome.js';
import type { CapturedSession } from '../src/worker/connect.js';

const e = process.env;
const dbUrl = `postgres://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD ?? '')}@127.0.0.1:${e.POSTGRES_HOST_PORT ?? '5435'}/${e.POSTGRES_DB}`;
const db = createDb(dbUrl);
const config = loadConfig({ ...e, DATABASE_URL: dbUrl } as Record<string, string>);

const { rows } = await db.query<{ id: string; session_sealed: string; addresses: unknown; cart_address: unknown }>(
  "select id, session_sealed, addresses, cart_address from vendor_connections where vendor = 'blinkit' and phone_last4 = $1",
  [e.PROBE_PHONE_LAST4 ?? '4567'],
);
const saved = readStoredAddresses(JSON.stringify({ addresses_data: rows[0].addresses }));
const chosen = rows[0].cart_address as { id?: string | number } | null;
const where = saved.find((a) => String(a.id) === String(chosen?.id)) ?? saved[0];
const session = JSON.parse(
  openSealed(config.vault.privateKeys, rows[0].session_sealed, `vendor_connections:${rows[0].id}:session`),
) as CapturedSession;

// The names from the household's last cart, which is what this has to be
// right about.
const { rows: carts } = await db.query<{ wanted: { product: string; pack: string }[] }>(
  "select wanted from cart_jobs where vendor = 'blinkit' and wanted is not null order by created_at desc limit 1",
);
const wanted = carts[0]?.wanted ?? [];

const s = await blinkitPageAdapter(() => launchHeadless(e.CHROME_PATH, e.CHROME_VERSION)).open(session, where);
const bk = (s as unknown as {
  bk: {
    lookup(n: string, p: string): Promise<unknown>;
    call(p: string, m: 'GET' | 'POST' | 'PUT', b?: unknown): Promise<{ status: number; body: string }>;
  };
}).bk;
try {
  const all = Date.now();
  for (const w of wanted) {
    const at = Date.now();
    const said = await bk.lookup(w.product, w.pack);
    const how = typeof said === 'object' && said ? `found via "${(said as { query: string }).query}"` : String(said);
    console.log(`${String(Date.now() - at).padStart(6)} ms  ${how.padEnd(46)} ${w.product}`);
    // What the store DID answer, when this says it sells nothing of the
    // name. A wrong "not listed" would quietly stop buying the household's
    // food, so it has to be checkable.
    if (process.env.PROBE_WHY && said === 'not_listed') {
      const r = await bk.call(`/v1/layout/search?q=${encodeURIComponent(w.product)}`, 'POST', { q: w.product });
      const { addToCartItems } = await import('../src/worker/adapters/blinkit-cart.js');
      const items = r.status === 200 ? addToCartItems(JSON.parse(r.body)) : [];
      console.log(`         raw: HTTP ${r.status}, ${items.length} products`);
      for (const i of items.slice(0, 5)) console.log(`            ${i.product_name} | ${i.unit} | stock ${i.inventory ?? '?'}`);
    }
  }
  console.log(`\n${wanted.length} looked up in ${((Date.now() - all) / 1000).toFixed(1)}s`);
} finally {
  await s.close();
  await db.end();
}
