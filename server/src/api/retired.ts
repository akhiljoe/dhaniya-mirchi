// Items the household has said it no longer buys (migration 030). Kept as a
// stated fact, so the projection can be rebuilt without losing it; read by
// the page to leave those items out of the stock list, the running-low list
// and "not bought lately". Household-scoped via requireHousehold; any member
// may say so, and any member may take it back.
//
//   GET /api/household/retired              → { items: [{ item, retiredAt }] }
//   PUT /api/household/retired              { item, retired: boolean } → { items }
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { ITEM_KEY_MAX, MAX_BODY_BYTES } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireHousehold } from './households.js';

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/;

export function validateRetirement(body: unknown): { item: string; retired: boolean } {
  const b = (body ?? {}) as Record<string, unknown>;
  const item = typeof b.item === 'string' ? b.item.toLowerCase().replace(/\s+/g, ' ').trim() : '';
  if (!item || item.length > ITEM_KEY_MAX || CONTROL.test(item)) throw new HttpError(400, 'Say which item.');
  if (typeof b.retired !== 'boolean') throw new HttpError(400, 'Say whether you still buy it.');
  return { item, retired: b.retired };
}

export async function handleRetired(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/household/retired') return false;
  const { db } = deps;

  const list = async (householdId: string) => {
    const { rows } = await db.query<{ item: string; retired_at: Date }>(
      'select item, retired_at from item_retirements where household_id = $1 order by retired_at desc',
      [householdId],
    );
    return rows.map((r) => ({ item: r.item, retiredAt: r.retired_at.toISOString() }));
  };

  if (req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    sendJson(res, 200, { items: await list(household.id) });
    return true;
  }

  if (req.method === 'PUT') {
    const { userId, household } = await requireHousehold(deps, req);
    const { item, retired } = validateRetirement(await readJson(req, MAX_BODY_BYTES));
    if (retired) {
      await db.query(
        `insert into item_retirements (household_id, item, retired_by) values ($1, $2, $3)
         on conflict (household_id, item) do nothing`,
        [household.id, item, userId],
      );
    } else {
      await db.query('delete from item_retirements where household_id = $1 and item = $2', [household.id, item]);
    }
    sendJson(res, 200, { items: await list(household.id) });
    return true;
  }

  return false;
}
