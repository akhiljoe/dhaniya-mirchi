// Household facts (design §9.12): who lives here, guests, pets, regular use,
// time away. The browser's engine reads them with the orders.
//
//   GET  /api/household/facts               → { facts: [...] } the ones in force, oldest first
//   POST /api/household/facts               { kind, startsOn, endsOn, details, said, source? } → 201 { fact }
//                                           source 'ai' = confirmed from an AI proposal (§7.8), for the
//                                           settings page's "what it did"; anything else is 'form'
//   POST /api/household/facts/:id/withdraw  → { withdrawn: true }
//
// Household-scoped via requireHousehold; any member may add or withdraw (they
// all live there). Append-only: nothing is updated in place or deleted.
// `validateFact` is shared with the AI layer (design §7.8): a proposal from
// the model passes the same checks before anyone can confirm it.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import {
  FACT_ITEM_MAX,
  FACT_KINDS,
  FACT_MAX_DAYS_AHEAD,
  FACT_MAX_DAYS_BACK,
  FACT_MAX_PEOPLE,
  FACT_MAX_PER_DAY,
  FACT_MAX_PETS,
  FACT_SAID_MAX,
  MAX_BODY_BYTES,
  MS_PER_DAY,
  type FactKind,
} from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { requireHousehold } from './households.js';

export interface FactInput {
  kind: FactKind;
  startsOn: string; // YYYY-MM-DD, the household's local date
  endsOn: string | null; // the last day it holds; null = open
  details: Record<string, unknown>;
  said: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isInt = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Checks one fact and returns it in its stored shape, or throws a 400 with a
// sentence the page can show. `today` is the household's local date.
export function validateFact(body: unknown, today: string): FactInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind as FactKind;
  if (!FACT_KINDS.includes(kind)) throw new HttpError(400, 'Unknown kind of fact.');
  if (!validDate(b.startsOn)) throw new HttpError(400, 'Give the start date as YYYY-MM-DD.');
  const endsOn = b.endsOn === null || b.endsOn === undefined ? null : b.endsOn;
  if (endsOn !== null && !validDate(endsOn)) throw new HttpError(400, 'Give the end date as YYYY-MM-DD.');
  if (endsOn !== null && endsOn < b.startsOn) throw new HttpError(400, 'The end date is before the start date.');
  const days = (s: string) => (new Date(`${s}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / MS_PER_DAY;
  if (days(b.startsOn) < -FACT_MAX_DAYS_BACK || days(b.startsOn) > FACT_MAX_DAYS_AHEAD) throw new HttpError(400, 'That date is too far away.');
  if (endsOn !== null && days(endsOn) > FACT_MAX_DAYS_AHEAD) throw new HttpError(400, 'That date is too far away.');
  const said = b.said === null || b.said === undefined ? null : typeof b.said === 'string' ? b.said.trim() || null : undefined;
  if (said === undefined || (said !== null && said.length > FACT_SAID_MAX)) throw new HttpError(400, `Keep the note under ${FACT_SAID_MAX} characters.`);

  const d = (b.details ?? {}) as Record<string, unknown>;
  let details: Record<string, unknown>;
  switch (kind) {
    case 'people':
      if (!isInt(d.count, 1, FACT_MAX_PEOPLE)) throw new HttpError(400, `Say how many people live here (1 to ${FACT_MAX_PEOPLE}).`);
      if (endsOn !== null) throw new HttpError(400, 'Who lives here holds until it changes. Use guests for a stay with an end.');
      details = { count: d.count };
      break;
    case 'guests':
      if (!isInt(d.count, 1, FACT_MAX_PEOPLE)) throw new HttpError(400, `Say how many guests (1 to ${FACT_MAX_PEOPLE}).`);
      if (endsOn === null) throw new HttpError(400, 'Say until when they stay.');
      details = { count: d.count };
      break;
    case 'pets': {
      const n = (k: string) => (d[k] === undefined ? 0 : d[k]);
      const [dogs, cats, other] = [n('dogs'), n('cats'), n('other')];
      if (![dogs, cats, other].every((x) => isInt(x, 0, FACT_MAX_PETS))) throw new HttpError(400, `Pets are counted 0 to ${FACT_MAX_PETS}.`);
      if (endsOn !== null) throw new HttpError(400, 'Pets hold until it changes.');
      details = { dogs, cats, other };
      break;
    }
    case 'regular_use': {
      const item = typeof d.item === 'string' ? d.item.trim().toLowerCase() : '';
      if (!item || item.length > FACT_ITEM_MAX) throw new HttpError(400, 'Say which item.');
      if (d.for !== 'people' && d.for !== 'pets') throw new HttpError(400, 'Say whether people or pets use it.');
      const perDay = d.perDay === null || d.perDay === undefined ? null : d.perDay;
      if (perDay !== null && !(typeof perDay === 'number' && perDay > 0 && perDay <= FACT_MAX_PER_DAY)) throw new HttpError(400, 'The amount a day must be a positive number.');
      const unit = perDay === null ? null : d.unit;
      if (perDay !== null && unit !== 'ml' && unit !== 'g' && unit !== 'piece') throw new HttpError(400, 'Give the amount in ml, g or pieces.');
      details = { item, for: d.for, perDay, unit };
      break;
    }
    case 'away':
      details = {};
      break;
  }
  return { kind, startsOn: b.startsOn, endsOn, details, said };
}

interface FactRow {
  id: string;
  kind: FactKind;
  starts_on: string;
  ends_on: string | null;
  details: Record<string, unknown>;
  said: string | null;
  source: string;
  created_by_email: string | null;
  created_at: Date;
}

const toJson = (r: FactRow) => ({
  id: r.id,
  kind: r.kind,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  details: r.details,
  said: r.said,
  source: r.source,
  addedBy: r.created_by_email,
  createdAt: r.created_at.toISOString(),
});

const SELECT = `select f.id, f.kind, to_char(f.starts_on, 'YYYY-MM-DD') as starts_on, to_char(f.ends_on, 'YYYY-MM-DD') as ends_on,
                       f.details, f.said, f.source, u.email as created_by_email, f.created_at
                  from household_facts f left join users u on u.id = f.created_by`;

// Today in the household's timezone, as YYYY-MM-DD.
export function localToday(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Stores a checked fact. Used by the form route and, later, by confirming an
// AI proposal (source 'ai').
export async function insertFact(deps: AuthDeps, householdId: string, userId: string, f: FactInput, source: 'form' | 'ai' | 'suggestion') {
  const { rows } = await deps.db.query<{ id: string }>(
    `insert into household_facts (household_id, kind, starts_on, ends_on, details, said, source, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [householdId, f.kind, f.startsOn, f.endsOn, JSON.stringify(f.details), f.said, source, userId],
  );
  const { rows: out } = await deps.db.query<FactRow>(`${SELECT} where f.id = $1`, [rows[0].id]);
  return toJson(out[0]);
}

export async function handleFacts(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/household/facts' && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await deps.db.query<FactRow>(
      `${SELECT} where f.household_id = $1 and f.withdrawn_at is null order by f.starts_on, f.created_at`,
      [household.id],
    );
    sendJson(res, 200, { facts: rows.map(toJson) });
    return true;
  }

  if (url.pathname === '/api/household/facts' && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    const body = await readJson(req, MAX_BODY_BYTES);
    const fact = validateFact(body, localToday(household.timezone));
    const source = (body as { source?: unknown })?.source === 'ai' ? 'ai' : 'form';
    sendJson(res, 201, { fact: await insertFact(deps, household.id, userId, fact, source) });
    return true;
  }

  const withdraw = url.pathname.match(/^\/api\/household\/facts\/([0-9a-f-]{36})\/withdraw$/);
  if (withdraw && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    const { rowCount } = await deps.db.query(
      `update household_facts set withdrawn_at = now(), withdrawn_by = $3
        where id = $1 and household_id = $2 and withdrawn_at is null`,
      [withdraw[1], household.id, userId],
    );
    if (!rowCount) throw new HttpError(404, 'No such fact.');
    sendJson(res, 200, { withdrawn: true });
    return true;
  }

  return false;
}
