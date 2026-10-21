// The AI layer's api (design §7.8, §19). Household-scoped via requireHousehold.
//
//   POST /api/ai/parse                     { text, items } → 202 { id, removed }  read these words into facts
//   POST /api/ai/meal                      { text, items } → 202 { id }  what a dish needs (design §19)
//   GET  /api/ai/requests/:id              → { status, result, errorCode }
//   POST /api/ai/requests/:id/outcome      { confirmed, discarded } → what the person kept
//   GET  /api/ai/settings                  → key, allowance, estimate, real usage, value
//   POST /api/ai/key                       { key } → 202  seal a household's own OpenAI key, then check it
//   POST /api/ai/key/remove
//   GET  /api/household/measures           → the household's own measures ("glass" = 250 ml)
//   POST /api/household/measures           { measure, unit, amount }
//
// The api seals a key and can never open it (§14.3); the worker makes every
// call. The page never gets a key back — only its last four characters.
//
// Guardrails at the door (design §7.8 "Guardrails", guard.ts): the site-wide
// switch; private details cut from the note before it is stored or sent;
// only name-like item names; one note in flight per household, and limits
// an hour per person and a day per household on any key; our key's budget
// for the whole site.
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AuthDeps } from '../auth/routes.js';
import {
  AI_CONTEXT_ITEMS_MAX,
  AI_ESTIMATE_CALLS_PER_MONTH,
  AI_ESTIMATE_INPUT_TOKENS,
  AI_ESTIMATE_OUTPUT_TOKENS,
  AI_FREE_CALLS_PER_MONTH,
  AI_KEY_CHECKS_PER_DAY,
  AI_NOTES_PER_HOUSEHOLD_DAY,
  AI_NOTES_PER_USER_HOUR,
  AI_PRICES_USD_PER_MTOK,
  AI_RESULT_KEEP_DAYS,
  AI_SITE_FREE_CALLS_PER_MONTH,
  AI_STALE_SECONDS,
  AI_TEXT_MAX,
  INR_PER_USD,
  MAX_BODY_BYTES,
} from '../constants.js';
import { HttpError, readJson, sendJson } from '../http.js';
import { seal } from '../vault.js';
import { cleanItemName, cleanNote, REMOVED_MARK } from '../ai/guard.js';
import { allowanceUsed, siteAllowanceUsed } from '../worker/ai.js';
import { localToday } from './facts.js';
import { requireHousehold } from './households.js';

const UNITS = ['ml', 'g', 'piece'] as const;
const OPENAI_KEY = /^sk-[A-Za-z0-9_-]{20,300}$/;
const UUID = '([0-9a-f-]{36})';

// Cost in US dollars of some tokens on a model; null when its price isn't known.
export function costUsd(model: string, input: number, output: number): number | null {
  const p = AI_PRICES_USD_PER_MTOK[model];
  return p ? (input * p[0] + output * p[1]) / 1_000_000 : null;
}

function modelInUse(deps: AuthDeps, ownKey: boolean): string | null {
  if (ownKey || deps.config.ai.provider === 'openai') return deps.config.ai.openaiModel;
  if (deps.config.ai.provider === 'anthropic') return deps.config.ai.anthropicModel;
  return null;
}

const PAUSED = 'The AI is paused on this site for now. Use the forms below.';

// How many of a household's requests of a purpose in the last `seconds`,
// optionally only one person's.
async function recent(deps: AuthDeps, householdId: string, purpose: string, seconds: number, userId?: string): Promise<number> {
  const { rows } = await deps.db.query<{ n: string }>(
    `select count(*) as n from ai_requests
      where household_id = $1 and purpose = $2 and created_at > now() - make_interval(secs => $3)
        and ($4::text is null or user_id = $4)`,
    [householdId, purpose, seconds, userId ?? null],
  );
  return Number(rows[0].n);
}

export async function handleAi(deps: AuthDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { db } = deps;

  // The same door as /api/ai/parse, and the same limits: a meal plan is one
  // more thing the model is asked, on the same allowance.
  const meal = url.pathname === '/api/ai/meal';
  if ((url.pathname === '/api/ai/parse' || meal) && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    if (!deps.config.ai.enabled) throw new HttpError(409, PAUSED);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { text?: unknown; items?: unknown };
    const raw = typeof body.text === 'string' ? body.text : '';
    if (raw.length > AI_TEXT_MAX) throw new HttpError(400, `Keep it under ${AI_TEXT_MAX} characters.`);
    // Private details are cut here, before the note is stored or sent.
    const { text, removed } = cleanNote(raw);
    if (!text.split(REMOVED_MARK).join('').trim()) throw new HttpError(400, 'Write something first.');
    const seen = new Set<string>();
    const items: { id: string; unit: (typeof UNITS)[number] }[] = [];
    for (const i of Array.isArray(body.items) ? body.items : []) {
      const id = typeof i?.id === 'string' ? cleanItemName(i.id) : null;
      if (id === null || seen.has(id) || !UNITS.includes(i?.unit) || items.length >= AI_CONTEXT_ITEMS_MAX) continue;
      seen.add(id);
      items.push({ id, unit: i.unit });
    }

    // Limits on any key: one note at a time, then per person and per household.
    const { rowCount: inFlight } = await db.query(
      `select 1 from ai_requests where household_id = $1 and status in ('requested', 'running')
          and updated_at > now() - make_interval(secs => $2)`,
      [household.id, AI_STALE_SECONDS],
    );
    if (inFlight) throw new HttpError(429, 'The last note is still being read. Wait for it, then send this one.');
    const purpose = meal ? 'plan_meal' : 'parse_facts';
    if ((await recent(deps, household.id, purpose, 3600, userId)) >= AI_NOTES_PER_USER_HOUR) {
      throw new HttpError(429, `That's ${AI_NOTES_PER_USER_HOUR} notes this hour. Try again later, or use the forms below.`);
    }
    if ((await recent(deps, household.id, purpose, 86_400)) >= AI_NOTES_PER_HOUSEHOLD_DAY) {
      throw new HttpError(429, `Your household sent ${AI_NOTES_PER_HOUSEHOLD_DAY} notes today. Try again tomorrow, or use the forms below.`);
    }

    // Say at once when nothing can answer, rather than after a round trip.
    const own = await db.query('select 1 from household_ai_keys where household_id = $1', [household.id]);
    if (!own.rowCount) {
      if (deps.config.ai.provider === 'off') throw new HttpError(409, 'The AI is off on this site. Use the forms below, or add your own key in AI settings.');
      if ((await allowanceUsed(db, household.id, household.timezone, new Date())) >= AI_FREE_CALLS_PER_MONTH) {
        throw new HttpError(409, 'This month’s free AI uses are used up. Use the forms, or add your own key in AI settings.');
      }
      if ((await siteAllowanceUsed(db, new Date())) >= AI_SITE_FREE_CALLS_PER_MONTH) {
        throw new HttpError(409, 'The free AI uses on this site are used up this month. Use the forms, or add your own key in AI settings.');
      }
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into ai_requests (household_id, user_id, purpose, text, context, status)
       values ($1, $2, $5, $3, $4, 'requested') returning id`,
      [household.id, userId, text, JSON.stringify({ items }), meal ? 'plan_meal' : 'parse_facts'],
    );
    await db.query(`select pg_notify('ai_requests', $1)`, [rows[0].id]);
    sendJson(res, 202, { id: rows[0].id, removed });
    return true;
  }

  const status = url.pathname.match(new RegExp(`^/api/ai/requests/${UUID}$`));
  if (status && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ status: string; result: unknown; error_code: string | null }>(
      'select status, result, error_code from ai_requests where id = $1 and household_id = $2',
      [status[1], household.id],
    );
    if (!rows.length) throw new HttpError(404, 'No such request.');
    sendJson(res, 200, { status: rows[0].status, result: rows[0].result, errorCode: rows[0].error_code });
    return true;
  }

  const outcome = url.pathname.match(new RegExp(`^/api/ai/requests/${UUID}/outcome$`));
  if (outcome && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { confirmed?: unknown; discarded?: unknown };
    const n = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 20 ? (x as number) : 0);
    const { rowCount } = await db.query('update ai_requests set confirmed = $3, discarded = $4 where id = $1 and household_id = $2', [
      outcome[1],
      household.id,
      n(body.confirmed),
      n(body.discarded),
    ]);
    if (!rowCount) throw new HttpError(404, 'No such request.');
    sendJson(res, 200, { saved: true });
    return true;
  }

  if (url.pathname === '/api/ai/settings' && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const tz = household.timezone;
    const { rows: keyRows } = await db.query<{ provider: string; key_last4: string; checked_at: Date | null; created_at: Date }>(
      'select provider, key_last4, checked_at, created_at from household_ai_keys where household_id = $1',
      [household.id],
    );
    const ownKey = keyRows[0] ?? null;
    // Real usage, by model (prices differ): this calendar month and the last 30 days.
    const monthStart = `${localToday(tz).slice(0, 7)}-01`;
    const { rows: usage } = await db.query<{ span: string; model: string; key_source: string; calls: string; ok: string; input: string; output: string }>(
      `select w.span, c.model, c.key_source, count(*) as calls, count(*) filter (where c.ok) as ok,
              coalesce(sum(c.input_tokens), 0) as input, coalesce(sum(c.output_tokens), 0) as output
         from ai_calls c
         cross join lateral (values
           ('month', c.created_at >= ($2::date::timestamp at time zone $3)),
           ('days30', c.created_at >= now() - interval '30 days')) as w(span, inside)
        where c.household_id = $1 and w.inside
        group by w.span, c.model, c.key_source`,
      [household.id, monthStart, tz],
    );
    const sum = (span: string) => {
      const rows = usage.filter((u) => u.span === span);
      const input = rows.reduce((n, r) => n + Number(r.input), 0);
      const output = rows.reduce((n, r) => n + Number(r.output), 0);
      const costs = rows.map((r) => costUsd(r.model, Number(r.input), Number(r.output)));
      const usd = costs.every((c) => c !== null) ? costs.reduce((n, c) => n! + c!, 0)! : null;
      return {
        calls: rows.reduce((n, r) => n + Number(r.calls), 0),
        failed: rows.reduce((n, r) => n + Number(r.calls) - Number(r.ok), 0),
        inputTokens: input,
        outputTokens: output,
        usd,
        inr: usd === null ? null : usd * INR_PER_USD,
        onOwnKey: rows.filter((r) => r.key_source === 'own').reduce((n, r) => n + Number(r.calls), 0),
      };
    };
    // What it did for the household this month.
    const { rows: value } = await db.query<{ messages: string; questions: string; confirmed: string; discarded: string; facts: string }>(
      `select count(*) filter (where purpose = 'parse_facts' and status = 'done') as messages,
              coalesce(sum(jsonb_array_length(coalesce(result->'questions', '[]'::jsonb))) filter (where purpose = 'parse_facts'), 0) as questions,
              coalesce(sum(confirmed), 0) as confirmed, coalesce(sum(discarded), 0) as discarded,
              (select count(*) from household_facts f where f.household_id = $1 and f.source = 'ai'
                 and f.created_at >= ($2::date::timestamp at time zone $3)) as facts
         from ai_requests where household_id = $1 and created_at >= ($2::date::timestamp at time zone $3)`,
      [household.id, monthStart, tz],
    );
    const model = modelInUse(deps, !!ownKey);
    // The estimate is for what would answer: with the AI off, what the
    // household's own OpenAI key would cost.
    const estimateModel = model ?? deps.config.ai.openaiModel;
    const estimateUsd = costUsd(estimateModel, AI_ESTIMATE_CALLS_PER_MONTH * AI_ESTIMATE_INPUT_TOKENS, AI_ESTIMATE_CALLS_PER_MONTH * AI_ESTIMATE_OUTPUT_TOKENS);
    const next = new Date(`${monthStart}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    sendJson(res, 200, {
      available: deps.config.ai.enabled && (!!ownKey || deps.config.ai.provider !== 'off'),
      paused: !deps.config.ai.enabled,
      limits: { perUserHour: AI_NOTES_PER_USER_HOUR, perHouseholdDay: AI_NOTES_PER_HOUSEHOLD_DAY, keepDays: AI_RESULT_KEEP_DAYS },
      model,
      ownKey: ownKey && { provider: ownKey.provider, last4: ownKey.key_last4, checked: !!ownKey.checked_at, addedAt: ownKey.created_at.toISOString() },
      allowance:
        deps.config.ai.provider === 'off'
          ? null
          : { used: await allowanceUsed(db, household.id, tz, new Date()), limit: AI_FREE_CALLS_PER_MONTH, resetsOn: next.toISOString().slice(0, 10) },
      estimate: {
        calls: AI_ESTIMATE_CALLS_PER_MONTH,
        inputTokens: AI_ESTIMATE_CALLS_PER_MONTH * AI_ESTIMATE_INPUT_TOKENS,
        outputTokens: AI_ESTIMATE_CALLS_PER_MONTH * AI_ESTIMATE_OUTPUT_TOKENS,
        usd: estimateUsd,
        inr: estimateUsd === null ? null : estimateUsd * INR_PER_USD,
        model: estimateModel,
        prices: AI_PRICES_USD_PER_MTOK[estimateModel] ?? null,
      },
      usage: { month: sum('month'), days30: sum('days30') },
      value: {
        messages: Number(value[0].messages),
        facts: Number(value[0].facts),
        questions: Number(value[0].questions),
        confirmed: Number(value[0].confirmed),
        discarded: Number(value[0].discarded),
      },
    });
    return true;
  }

  if (url.pathname === '/api/ai/key' && req.method === 'POST') {
    const { userId, household } = await requireHousehold(deps, req);
    if (!deps.config.ai.enabled) throw new HttpError(409, PAUSED);
    const publicKey = deps.config.vault.publicKey;
    if (!publicKey) throw new HttpError(503, 'Keys can’t be stored on this server yet.');
    const body = (await readJson(req, MAX_BODY_BYTES)) as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    // Only the shape is checked here; the worker's check call proves it works.
    if (!OPENAI_KEY.test(key)) throw new HttpError(400, 'That doesn’t look like an OpenAI key. It starts with sk-.');
    // Each save costs a check call; a few a day is plenty for a real key.
    if ((await recent(deps, household.id, 'check_key', 86_400)) >= AI_KEY_CHECKS_PER_DAY) {
      throw new HttpError(429, `That's ${AI_KEY_CHECKS_PER_DAY} keys tried today. Try again tomorrow.`);
    }
    await db.query(
      `insert into household_ai_keys (household_id, provider, key_sealed, key_last4, created_by)
       values ($1, 'openai', $2, $3, $4)
       on conflict (household_id) do update
         set key_sealed = excluded.key_sealed, key_last4 = excluded.key_last4, checked_at = null,
             created_by = excluded.created_by, created_at = now()`,
      [household.id, seal(publicKey, key, `household_ai_keys:${household.id}:key`), key.slice(-4), userId],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into ai_requests (household_id, user_id, purpose, status) values ($1, $2, 'check_key', 'requested') returning id`,
      [household.id, userId],
    );
    await db.query(`select pg_notify('ai_requests', $1)`, [rows[0].id]);
    deps.logger.info('ai: own key saved', { household: household.id });
    sendJson(res, 202, { checkId: rows[0].id, last4: key.slice(-4) });
    return true;
  }

  if (url.pathname === '/api/ai/key/remove' && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    await db.query('delete from household_ai_keys where household_id = $1', [household.id]);
    sendJson(res, 200, { removed: true });
    return true;
  }

  if (url.pathname === '/api/household/measures' && req.method === 'GET') {
    const { household } = await requireHousehold(deps, req);
    const { rows } = await db.query<{ measure: string; unit: string; amount: string }>(
      'select measure, unit, amount from household_measures where household_id = $1 order by measure',
      [household.id],
    );
    sendJson(res, 200, { measures: rows.map((r) => ({ measure: r.measure, unit: r.unit, amount: Number(r.amount) })) });
    return true;
  }

  if (url.pathname === '/api/household/measures' && req.method === 'POST') {
    const { household } = await requireHousehold(deps, req);
    const body = (await readJson(req, MAX_BODY_BYTES)) as { measure?: unknown; unit?: unknown; amount?: unknown };
    const measure = typeof body.measure === 'string' ? body.measure.trim().toLowerCase() : '';
    if (!/^[a-z][a-z ]{0,29}$/.test(measure)) throw new HttpError(400, 'Name the measure in a word or two, like glass.');
    if (!UNITS.includes(body.unit as (typeof UNITS)[number])) throw new HttpError(400, 'The unit must be ml, g or piece.');
    if (!(typeof body.amount === 'number' && body.amount > 0 && body.amount <= 100_000)) throw new HttpError(400, 'Give a number above 0.');
    await db.query(
      `insert into household_measures (household_id, measure, unit, amount) values ($1, $2, $3, $4)
       on conflict (household_id, measure, unit) do update set amount = excluded.amount`,
      [household.id, measure, body.unit, body.amount],
    );
    sendJson(res, 201, { measure, unit: body.unit, amount: body.amount });
    return true;
  }

  return false;
}
