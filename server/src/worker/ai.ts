// The AI requests (design §7.8): read a household's words into proposed facts,
// or check a household's own key. In the worker because a household's key is
// sealed and only the worker can open it (§14.3).
//
//  - The household's own OpenAI key when it has one; otherwise our provider
//    within the monthly free allowance; otherwise nothing ("no_ai": the page
//    offers the forms).
//  - Every call is logged in ai_calls — provider, model, tokens, whether it
//    worked — never the text, never a key.
//  - The model's answer is read strictly (schema.ts), held to the note's own
//    words (guard.ts: numbers never said are dropped and asked), and turned
//    into facts by code (resolve.ts). Only that checked result is stored.
//  - Guardrails (design §7.8): the site-wide switch; our key's monthly budget
//    for the whole site; the note cleared once read, and the proposals that
//    quote it after AI_RESULT_KEEP_DAYS.
import {
  AI_FREE_CALLS_PER_MONTH,
  AI_MAX_CONCURRENT,
  AI_RESULT_KEEP_DAYS,
  AI_SITE_FREE_CALLS_PER_MONTH,
  AI_STALE_SECONDS,
  AI_SWEEP_MS,
  AI_CONTEXT_ITEMS_MAX,
} from '../constants.js';
import type { AiConfig, VaultConfig } from '../config.js';
import type { Db } from '../db.js';
import { errorFields, type Logger } from '../logger.js';
import { openSealed } from '../vault.js';
import { resolveAnswer, type ResolveContext, type Unit } from '../ai/resolve.js';
import { cleanItemName, cleanNote, groundAnswer } from '../ai/guard.js';
import { FACTS_SYSTEM_PROMPT, factsUserMessage, MEAL_SYSTEM_PROMPT, mealUserMessage } from '../ai/prompt.js';
import { MEAL_JSON_SCHEMA, readMeal, UnreadableMeal } from '../ai/meal-schema.js';
import { anthropicProvider, openaiProvider, ProviderError, type ModelProvider } from '../ai/providers.js';
import { readAnswer, UnreadableAnswer } from '../ai/schema.js';
import { startJobLoop, type JobLoop } from './job-loop.js';

export interface AiDeps {
  db: Db;
  logger: Logger;
  vault: VaultConfig;
  ai: AiConfig;
  // Tests hand in a provider; the worker builds them from config.
  providers?: { own?: (key: string) => ModelProvider; allowance?: ModelProvider | null };
  now?: () => Date;
}

type Source = { provider: ModelProvider; source: 'own' | 'allowance' };

// Our provider for the free allowance, from config (null = none).
export function allowanceProvider(ai: AiConfig): ModelProvider | null {
  if (ai.provider === 'openai' && ai.openaiKey) return openaiProvider(ai.openaiKey, ai.openaiModel);
  if (ai.provider === 'anthropic' && ai.anthropicKey) return anthropicProvider(ai.anthropicKey, ai.anthropicModel);
  return null;
}

const localDay = (tz: string, t: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const weekdayOf = (tz: string, t: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(t);

// Calls on our key this calendar month (household-local).
export async function allowanceUsed(db: Db, householdId: string, timezone: string, now: Date): Promise<number> {
  const monthStart = `${localDay(timezone, now).slice(0, 7)}-01`;
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from ai_calls
      where household_id = $1 and key_source = 'allowance' and created_at >= ($2::date::timestamp at time zone $3)`,
    [householdId, monthStart, timezone],
  );
  return Number(rows[0].n);
}

// Calls on our key this calendar month (UTC) by every household together:
// the site's budget (AI_SITE_FREE_CALLS_PER_MONTH).
export async function siteAllowanceUsed(db: Db, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from ai_calls where key_source = 'allowance' and created_at >= date_trunc('month', $1::timestamptz at time zone 'UTC') at time zone 'UTC'`,
    [now.toISOString()],
  );
  return Number(rows[0].n);
}

// A household's words are kept only while needed: proposals quoting them go
// after AI_RESULT_KEEP_DAYS (the note itself is cleared once read).
export async function forgetOldAiResults(db: Db): Promise<void> {
  await db.query(
    `update ai_requests set text = null, result = null, context = null
      where created_at < now() - make_interval(days => $1) and (text is not null or result is not null or context is not null)`,
    [AI_RESULT_KEEP_DAYS],
  );
}

export async function claimNextAiRequest(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `update ai_requests set status = 'running', updated_at = now()
      where id = (select id from ai_requests where status = 'requested' order by created_at for update skip locked limit 1)
      returning id`,
  );
  return rows[0]?.id ?? null;
}

// A request left running by a stopped worker: failed, not retried — the
// person is waiting on the page and can send again.
export async function failStaleAiRequests(db: Db): Promise<void> {
  await db.query(
    `update ai_requests set status = 'failed', error_code = 'provider_down', updated_at = now()
      where status = 'running' and updated_at < now() - make_interval(secs => $1)`,
    [AI_STALE_SECONDS],
  );
}

// The note is cleared here: it was needed only for the call (the proposals
// quote what they came from).
async function finish(db: Db, id: string, fields: { status: 'done' | 'failed'; result?: unknown; errorCode?: string }) {
  await db.query('update ai_requests set status = $2, result = $3, error_code = $4, text = null, updated_at = now() where id = $1', [
    id,
    fields.status,
    fields.result === undefined ? null : JSON.stringify(fields.result),
    fields.errorCode ?? null,
  ]);
}

export async function runAiRequest(deps: AiDeps, id: string): Promise<void> {
  const { db, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const { rows } = await db.query<{
    household_id: string;
    purpose: 'parse_facts' | 'check_key' | 'plan_meal';
    text: string | null;
    context: { items?: { id: string; unit: Unit }[] } | null;
    timezone: string;
    key_sealed: string | null;
  }>(
    `select r.household_id, r.purpose, r.text, r.context, h.timezone, k.key_sealed
       from ai_requests r join households h on h.id = r.household_id
       left join household_ai_keys k on k.household_id = r.household_id
      where r.id = $1`,
    [id],
  );
  const req = rows[0];
  if (!req) return;
  const log = { request: id, purpose: req.purpose };
  if (!deps.ai.enabled) return finish(db, id, { status: 'failed', errorCode: 'paused' });

  // Which key answers.
  let chosen: Source | null = null;
  if (req.key_sealed && deps.vault.privateKeys.length) {
    const key = openSealed(deps.vault.privateKeys, req.key_sealed, `household_ai_keys:${req.household_id}:key`);
    chosen = { provider: (deps.providers?.own ?? ((k) => openaiProvider(k, deps.ai.openaiModel)))(key), source: 'own' };
  } else if (req.purpose !== 'check_key') {
    const provider = deps.providers && 'allowance' in deps.providers ? deps.providers.allowance ?? null : allowanceProvider(deps.ai);
    if (!provider) return finish(db, id, { status: 'failed', errorCode: 'no_ai' });
    if ((await allowanceUsed(db, req.household_id, req.timezone, now)) >= AI_FREE_CALLS_PER_MONTH) {
      return finish(db, id, { status: 'failed', errorCode: 'allowance_used' });
    }
    if ((await siteAllowanceUsed(db, now)) >= AI_SITE_FREE_CALLS_PER_MONTH) {
      logger.info('ai: site allowance used up', log);
      return finish(db, id, { status: 'failed', errorCode: 'allowance_used' });
    }
    chosen = { provider, source: 'allowance' };
  }
  if (!chosen) return finish(db, id, { status: 'failed', errorCode: 'no_ai' });

  // What the model reads: the note and just enough context (§7.8).
  const today = localDay(req.timezone, now);
  const { rows: facts } = await db.query<{ starts_on: string; count: number }>(
    `select to_char(starts_on, 'YYYY-MM-DD') as starts_on, (details->>'count')::int as count
       from household_facts where household_id = $1 and kind = 'people' and withdrawn_at is null
      order by starts_on, created_at`,
    [req.household_id],
  );
  const peopleOn = (day: string) => [...facts].reverse().find((f) => f.starts_on <= day)?.count ?? null;
  const { rows: pets } = await db.query<{ starts_on: string; dogs: number; cats: number; other: number }>(
    `select to_char(starts_on, 'YYYY-MM-DD') as starts_on, (details->>'dogs')::int as dogs, (details->>'cats')::int as cats, (details->>'other')::int as other
       from household_facts where household_id = $1 and kind = 'pets' and withdrawn_at is null
      order by starts_on, created_at`,
    [req.household_id],
  );
  const petsOn = (day: string) => [...pets].reverse().find((p) => p.starts_on <= day) ?? null;
  // Cleaned again here: whatever wrote the row, the model gets only this.
  const items = (req.context?.items ?? [])
    .map((i) => ({ id: cleanItemName(i.id), unit: i.unit }))
    .filter((i): i is { id: string; unit: Unit } => i.id !== null)
    .slice(0, AI_CONTEXT_ITEMS_MAX);
  const text = req.purpose === 'check_key' ? 'We are 2 people.' : cleanNote(req.text ?? '').text;
  if (!text) return finish(db, id, { status: 'failed', errorCode: 'unreadable' });
  const meal = req.purpose === 'plan_meal';
  const system = meal ? MEAL_SYSTEM_PROMPT : FACTS_SYSTEM_PROMPT;
  const schema = meal ? MEAL_JSON_SCHEMA : undefined;
  const user = meal
    ? mealUserMessage(text, { items: items.map((i) => i.id), people: peopleOn(today) })
    : factsUserMessage(text, { today, weekday: weekdayOf(req.timezone, now), items: items.map((i) => i.id), people: peopleOn(today) });

  const record = (ok: boolean, model: string, input: number, output: number) =>
    db.query(
      `insert into ai_calls (household_id, request_id, provider, model, key_source, input_tokens, output_tokens, ok)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [req.household_id, id, chosen!.provider.name, model, chosen!.source, input, output, ok],
    );

  let reply;
  try {
    reply = await chosen.provider.answer(system, user, schema);
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : 'provider_down';
    const tokens = err instanceof ProviderError ? err.tokens : { input: 0, output: 0 };
    await record(false, chosen.provider.model, tokens.input, tokens.output);
    if (!(err instanceof ProviderError)) logger.error('ai: call crashed', { ...log, ...errorFields(err) });
    else logger.info('ai: call failed', { ...log, code, provider: chosen.provider.name });
    // A key the provider refuses is removed: it would only fail again.
    if (code === 'key_rejected' && chosen.source === 'own') await db.query('delete from household_ai_keys where household_id = $1', [req.household_id]);
    return finish(db, id, { status: 'failed', errorCode: code });
  }
  await record(true, reply.model, reply.inputTokens, reply.outputTokens);

  if (req.purpose === 'check_key') {
    await db.query('update household_ai_keys set checked_at = now() where household_id = $1', [req.household_id]);
    return finish(db, id, { status: 'done', result: { checked: true } });
  }

  // What a dish needs. Only the model's own list: matching it to the
  // household's items and to what is at home is code's job, on the page.
  if (meal) {
    try {
      const dish = readMeal(reply.json);
      await finish(db, id, { status: 'done', result: { meal: dish, provider: chosen.provider.name, model: reply.model } });
      logger.info('ai: meal planned', { ...log, ingredients: dish.ingredients.length, serves: dish.serves });
    } catch (err) {
      if (!(err instanceof UnreadableMeal)) throw err;
      logger.info('ai: meal unreadable', { ...log, why: err.message });
      await finish(db, id, { status: 'failed', errorCode: 'unreadable' });
    }
    return;
  }

  try {
    const read = readAnswer(reply.json);
    const pets = petsOn(today);
    const { answer, report } = groundAnswer(read, text, { people: peopleOn(today), pets: pets && { dogs: pets.dogs, cats: pets.cats, other: pets.other } });
    const { rows: measures } = await db.query<{ measure: string; unit: Unit; amount: string }>(
      'select measure, unit, amount from household_measures where household_id = $1',
      [req.household_id],
    );
    const ctx: ResolveContext = {
      today,
      items,
      measures: measures.map((m) => ({ ...m, amount: Number(m.amount) })),
      peopleOn,
      petsOn,
    };
    const result = resolveAnswer(answer, ctx);
    await finish(db, id, { status: 'done', result: { ...result, provider: chosen.provider.name, model: reply.model } });
    // Counts only: what the guard held back, never the words.
    logger.info('ai: read', { ...log, facts: result.proposals.length, questions: result.questions.length, ...report });
  } catch (err) {
    if (!(err instanceof UnreadableAnswer)) throw err;
    logger.info('ai: answer unreadable', { ...log, why: err.message });
    await finish(db, id, { status: 'failed', errorCode: 'unreadable' });
  }
}

export function startAiLoop(deps: AiDeps, databaseUrl: string): Promise<JobLoop> {
  return startJobLoop({
    name: 'ai',
    channel: 'ai_requests',
    databaseUrl,
    logger: deps.logger,
    sweepMs: AI_SWEEP_MS,
    maxConcurrent: AI_MAX_CONCURRENT,
    beforeSweep: async () => {
      await failStaleAiRequests(deps.db);
      await forgetOldAiResults(deps.db);
    },
    claim: () => claimNextAiRequest(deps.db),
    run: (id) => runAiRequest(deps, id),
  });
}
