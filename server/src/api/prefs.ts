// Product preferences (design §19 Ordering, "which product"): for each item,
// the products the household wants, in order, and the ones never to add.
// Household-scoped via requireHousehold; any member may change them.
//
//   GET /api/household/product-prefs         → { prefs: [{ item, ranked, blocked, updatedAt }] }
//   PUT /api/household/product-prefs         { item, ranked, blocked } → { pref }
//                                            both empty: back to the household's own buying order
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { MAX_BODY_BYTES, PRODUCT_NAME_MAX, PRODUCT_PREFS_MAX } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireHousehold } from './households.js';

export interface ProductPrefInput {
  item: string;
  ranked: string[];
  blocked: string[];
}

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/;
const key = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

function names(x: unknown, what: string): string[] {
  if (!Array.isArray(x)) throw new HttpError(400, `${what} must be a list of product names.`);
  if (x.length > PRODUCT_PREFS_MAX) throw new HttpError(400, `At most ${PRODUCT_PREFS_MAX} products.`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of x) {
    if (typeof n !== 'string' || !n.trim() || n.length > PRODUCT_NAME_MAX || CONTROL.test(n)) throw new HttpError(400, 'A product name is not valid.');
    const k = key(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n.replace(/\s+/g, ' ').trim());
  }
  return out;
}

export function validatePref(body: unknown): ProductPrefInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const item = typeof b.item === 'string' ? b.item.trim() : '';
  if (!item || item.length > 60 || CONTROL.test(item)) throw new HttpError(400, 'Say which item.');
  const ranked = names(b.ranked ?? [], 'ranked');
  const blocked = names(b.blocked ?? [], 'blocked');
  const inRanked = new Set(ranked.map(key));
  if (blocked.some((n) => inRanked.has(key(n)))) throw new HttpError(400, 'A product can’t be both wanted and never added.');
  return { item, ranked, blocked };
}

export async function handleProductPrefs(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/household/product-prefs') return false;
  const { db } = deps;

  if (req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ item: string; ranked: string[]; blocked: string[]; updated_at: Date }>(
      'select item, ranked, blocked, updated_at from item_product_prefs where household_id = $1 order by item',
      [household.id],
    );
    sendJson(res, 200, { prefs: rows.map((r) => ({ item: r.item, ranked: r.ranked, blocked: r.blocked, updatedAt: r.updated_at.toISOString() })) });
    return true;
  }

  if (req.method === 'PUT') {
    const { userId, household } = await requireHousehold(deps, req);
    const p = validatePref(await readJson(req, MAX_BODY_BYTES));
    if (!p.ranked.length && !p.blocked.length) {
      await db.query('delete from item_product_prefs where household_id = $1 and item = $2', [household.id, p.item]);
      sendJson(res, 200, { pref: null });
      return true;
    }
    const { rows } = await db.query<{ updated_at: Date }>(
      `insert into item_product_prefs (household_id, item, ranked, blocked, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (household_id, item) do update
         set ranked = excluded.ranked, blocked = excluded.blocked, updated_by = excluded.updated_by, updated_at = now()
       returning updated_at`,
      [household.id, p.item, JSON.stringify(p.ranked), JSON.stringify(p.blocked), userId],
    );
    sendJson(res, 200, { pref: { ...p, updatedAt: rows[0].updated_at.toISOString() } });
    return true;
  }

  return false;
}
