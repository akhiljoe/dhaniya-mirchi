// What the household said about an item's estimate (migration 031): "I have
// more", "Already finished", "Not sure". Kept as a stated fact so it survives
// a reload and a rebuild of everything else. The page applies it until the
// item is next bought after it was said; the api only keeps the word and
// when it was given. Household-scoped; any member may say it.
//
//   GET /api/household/corrections          → { corrections: [{ item, kind, saidAt }] }
//   PUT /api/household/corrections          { item, kind } → { corrections }
//                                            kind null: take the correction back
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import { ITEM_KEY_MAX, MAX_BODY_BYTES } from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireHousehold } from './households.js';

export type CorrectionKind = 'more' | 'finished' | 'unsure';
const KINDS: CorrectionKind[] = ['more', 'finished', 'unsure'];

// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/;

export function validateCorrection(body: unknown): { item: string; kind: CorrectionKind | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  const item = typeof b.item === 'string' ? b.item.toLowerCase().replace(/\s+/g, ' ').trim() : '';
  if (!item || item.length > ITEM_KEY_MAX || CONTROL.test(item)) throw new HttpError(400, 'Say which item.');
  if (b.kind === null) return { item, kind: null };
  const kind = KINDS.find((k) => k === b.kind);
  if (!kind) throw new HttpError(400, 'Say what is wrong with the estimate.');
  return { item, kind };
}

export async function handleCorrections(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/household/corrections') return false;
  const { db } = deps;

  const list = async (householdId: string) => {
    const { rows } = await db.query<{ item: string; kind: CorrectionKind; said_at: Date }>(
      'select item, kind, said_at from item_corrections where household_id = $1 order by said_at desc',
      [householdId],
    );
    return rows.map((r) => ({ item: r.item, kind: r.kind, saidAt: r.said_at.toISOString() }));
  };

  if (req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    sendJson(res, 200, { corrections: await list(household.id) });
    return true;
  }

  if (req.method === 'PUT') {
    const { userId, household } = await requireHousehold(deps, req);
    const { item, kind } = validateCorrection(await readJson(req, MAX_BODY_BYTES));
    if (kind === null) {
      await db.query('delete from item_corrections where household_id = $1 and item = $2', [household.id, item]);
    } else {
      // The latest word wins, and said_at moves with it: "I have more" said
      // again today holds from today.
      await db.query(
        `insert into item_corrections (household_id, item, kind, said_by) values ($1, $2, $3, $4)
         on conflict (household_id, item) do update set kind = excluded.kind, said_at = now(), said_by = excluded.said_by`,
        [household.id, item, kind, userId],
      );
    }
    sendJson(res, 200, { corrections: await list(household.id) });
    return true;
  }

  return false;
}
