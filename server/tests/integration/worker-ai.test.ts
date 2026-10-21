// Reading households' words into facts, in the worker (design §7.8): the
// accuracy set end to end with recorded answers, which key answers, the
// monthly allowance, and every way a call can fail. No live model is called.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordedProvider, ProviderError, type ModelProvider } from '../../src/ai/providers.js';
import type { AiConfig } from '../../src/config.js';
import { AI_FREE_CALLS_PER_MONTH, AI_RESULT_KEEP_DAYS, AI_SITE_FREE_CALLS_PER_MONTH } from '../../src/constants.js';
import type { Db } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { generateVaultKeys, seal } from '../../src/vault.js';
import { forgetOldAiResults, runAiRequest, type AiDeps } from '../../src/worker/ai.js';
import { NOTES, NOTES_FACTS, NOTES_ITEMS } from '../fixtures/ai/notes.js';
import { freshTestDb } from './testdb.js';

const logger = createLogger({ level: 'error' });
const NOW = new Date('2026-09-19T06:30:00Z'); // Saturday noon in Kolkata
const vaultKeys = generateVaultKeys();
const vault = { publicKey: vaultKeys.publicKey, privateKeys: [vaultKeys.privateKey] };
const ai: AiConfig = { enabled: true, provider: 'anthropic', openaiKey: null, openaiModel: 'gpt-4.1-mini', anthropicKey: 'unused', anthropicModel: 'claude-opus-5' };
const recorded = recordedProvider(Object.fromEntries(NOTES.map((n) => [n.note, n.answer])));
let db: Db;
let householdId: string;

const deps = (over: Partial<AiDeps> = {}): AiDeps => ({ db, logger, vault, ai, providers: { allowance: recorded }, now: () => NOW, ...over });

async function request(text: string | null, purpose: 'parse_facts' | 'check_key' | 'plan_meal' = 'parse_facts'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into ai_requests (household_id, user_id, purpose, text, context, status) values ($1, 'sub_a', $2, $3, $4, 'running') returning id`,
    [householdId, purpose, text, JSON.stringify({ items: NOTES_ITEMS })],
  );
  return rows[0].id;
}
const outcome = async (id: string) =>
  (await db.query<{ status: string; result: any; error_code: string | null }>('select status, result, error_code from ai_requests where id = $1', [id])).rows[0];

beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query('truncate users, households cascade');
  await db.query(`insert into users (id, email) values ('sub_a', 'a@x.com')`);
  householdId = (await db.query<{ id: string }>(`insert into households (name, timezone) values ('Home', 'Asia/Kolkata') returning id`)).rows[0].id;
  await db.query(`insert into household_members (household_id, user_id, role) values ($1, 'sub_a', 'owner')`, [householdId]);
  for (const f of NOTES_FACTS) {
    await db.query(`insert into household_facts (household_id, kind, starts_on, details, source) values ($1, $2, $3, $4, 'form')`, [
      householdId,
      f.kind,
      f.startsOn,
      JSON.stringify(f.details),
    ]);
  }
});

describe('the accuracy set, end to end (recorded answers)', () => {
  for (const n of NOTES) {
    it(n.note, async () => {
      const id = await request(n.note);
      await runAiRequest(deps(), id);
      const r = await outcome(id);
      expect(r.status).toBe('done');
      expect(r.result.proposals).toHaveLength(n.expect.length);
      n.expect.forEach((want, i) => {
        const got = r.result.proposals[i];
        if ('fact' in want) {
          expect(got.missing).toEqual([]);
          expect(got.fact).toMatchObject(want.fact);
        } else {
          expect(got.fact).toBeNull();
          expect(got.missing.map((m: { field: string }) => m.field)).toEqual(want.missing);
        }
      });
      if (n.questions) expect(r.result.questions.length).toBeGreaterThan(0);
    });
  }

  it('uses a measure once the household has said it', async () => {
    await db.query(`insert into household_measures (household_id, measure, unit, amount) values ($1, 'glass', 'ml', 250)`, [householdId]);
    const id = await request('My wife and mother-in-law have tea twice a day, half a glass of milk each.');
    await runAiRequest(deps(), id);
    expect((await outcome(id)).result.proposals[0].fact.details).toEqual({ item: 'milk', for: 'people', perDay: 500, unit: 'ml' });
  });
});

describe('which key answers', () => {
  it("logs every call on the allowance, with tokens and never the text", async () => {
    const id = await request('3 friends are staying with us from Tuesday for a week.');
    await runAiRequest(deps(), id);
    const { rows } = await db.query('select provider, model, key_source, ok from ai_calls where request_id = $1', [id]);
    expect(rows).toEqual([{ provider: 'recorded', model: 'recorded', key_source: 'allowance', ok: true }]);
  });

  it("stops at the month's allowance", async () => {
    for (let i = 0; i < AI_FREE_CALLS_PER_MONTH; i++) {
      await db.query(`insert into ai_calls (household_id, provider, model, key_source, ok, created_at) values ($1, 'openai', 'gpt-4.1-mini', 'allowance', true, $2)`, [householdId, NOW]);
    }
    const id = await request('Hello');
    await runAiRequest(deps(), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'allowance_used' });
  });

  it('says there is no AI when nothing can answer', async () => {
    const id = await request('Hello');
    await runAiRequest(deps({ providers: { allowance: null } }), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'no_ai' });
  });

  it("uses the household's own key, opened only here, and without counting the allowance", async () => {
    await db.query(`insert into household_ai_keys (household_id, provider, key_sealed, key_last4) values ($1, 'openai', $2, 'wxyz')`, [
      householdId,
      seal(vault.publicKey, 'sk-own-key-abcdefghijklmnopqrstuvwxyz', `household_ai_keys:${householdId}:key`),
    ]);
    const keysSeen: string[] = [];
    const own = (key: string): ModelProvider => {
      keysSeen.push(key);
      return { ...recorded, name: 'openai', model: 'gpt-4.1-mini' };
    };
    const id = await request('We use about 2 litres of milk a day.');
    await runAiRequest(deps({ providers: { own, allowance: null } }), id);
    expect(keysSeen).toEqual(['sk-own-key-abcdefghijklmnopqrstuvwxyz']);
    expect((await outcome(id)).status).toBe('done');
    expect((await db.query('select key_source from ai_calls where request_id = $1', [id])).rows).toEqual([{ key_source: 'own' }]);
  });

  it('checks a new key, and removes one the provider refuses', async () => {
    const add = () =>
      db.query(`insert into household_ai_keys (household_id, provider, key_sealed, key_last4) values ($1, 'openai', $2, 'wxyz') on conflict do nothing`, [
        householdId,
        seal(vault.publicKey, 'sk-own-key-abcdefghijklmnopqrstuvwxyz', `household_ai_keys:${householdId}:key`),
      ]);
    await add();
    const good = await request(null, 'check_key');
    await runAiRequest(deps({ providers: { own: () => ({ name: 'openai', model: 'gpt-4.1-mini', answer: async () => ({ json: { facts: [], questions: [] }, model: 'gpt-4.1-mini', inputTokens: 10, outputTokens: 5 }) }) } }), good);
    expect((await outcome(good)).status).toBe('done');
    expect((await db.query('select checked_at from household_ai_keys')).rows[0].checked_at).not.toBeNull();

    const bad = await request(null, 'check_key');
    await runAiRequest(deps({ providers: { own: () => ({ name: 'openai', model: 'gpt-4.1-mini', answer: async () => { throw new ProviderError('key_rejected'); } }) } }), bad);
    expect(await outcome(bad)).toMatchObject({ status: 'failed', error_code: 'key_rejected' });
    expect((await db.query('select 1 from household_ai_keys')).rowCount).toBe(0);
  });
});

// "What do you want to make?" (design §19 "AI mode"). The model is the cook;
// what it answers is read strictly, and nothing it says touches an estimate.
describe('what a dish needs', () => {
  const biryani = {
    dish: 'chicken biryani',
    serves: 6,
    ingredients: [
      { name: 'chicken', quantity: 1500, unit: 'g', essential: true },
      { name: 'basmati rice', quantity: 1000, unit: 'g', essential: true },
      { name: 'curd', quantity: 300, unit: 'g', essential: true },
      { name: 'salt', quantity: null, unit: null, essential: true },
      { name: 'mint', quantity: 30, unit: 'g', essential: false },
    ],
    note: 'Hyderabadi style.',
  };
  const cook = (json: unknown): ModelProvider => ({ ...recorded, answer: async () => ({ json, model: 'recorded', inputTokens: 40, outputTokens: 90 }) });

  it('gives the dish, who it feeds and what it needs', async () => {
    const id = await request('chicken biryani for 6', 'plan_meal');
    await runAiRequest(deps({ providers: { allowance: cook(biryani) } }), id);
    const r = await outcome(id);
    expect(r.status).toBe('done');
    expect(r.result.meal).toMatchObject({ dish: 'chicken biryani', serves: 6, note: 'Hyderabadi style.' });
    expect(r.result.meal.ingredients).toHaveLength(5);
    expect(r.result.meal.ingredients[3]).toEqual({ name: 'salt', quantity: null, unit: null, essential: true });
  });

  it('asks the model as the cook, with what the household buys', async () => {
    let seen = { system: '', user: '' };
    const spy: ModelProvider = { ...recorded, answer: async (system, user) => ((seen = { system, user }), { json: biryani, model: 'recorded', inputTokens: 0, outputTokens: 0 }) };
    await runAiRequest(deps({ providers: { allowance: spy } }), await request('chicken biryani for 6', 'plan_meal'));
    expect(seen.system).toMatch(/cook/i);
    expect(seen.user).toContain('milk'); // the household's own items
    expect(seen.user).toContain('chicken biryani for 6');
  });

  it('keeps a meal off the household’s facts: it is a suggestion, not evidence', async () => {
    const id = await request('chicken biryani for 6', 'plan_meal');
    await runAiRequest(deps({ providers: { allowance: cook(biryani) } }), id);
    expect((await outcome(id)).result.proposals).toBeUndefined();
    expect((await db.query('select 1 from household_facts where source = $1', ['ai'])).rowCount).toBe(0);
  });

  it('refuses a recipe outside the shape, and stores nothing of it', async () => {
    const id = await request('chicken biryani for 6', 'plan_meal');
    await runAiRequest(deps({ providers: { allowance: cook({ ...biryani, ingredients: [{ name: 'chilli', quantity: 90_000, unit: 'g', essential: true }] }) } }), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'unreadable', result: null });
  });

  it('counts against the same allowance as everything else', async () => {
    const id = await request('pasta tonight', 'plan_meal');
    await runAiRequest(deps({ providers: { allowance: cook(biryani) } }), id);
    expect((await db.query('select key_source, input_tokens from ai_calls where request_id = $1', [id])).rows).toEqual([
      { key_source: 'allowance', input_tokens: 40 },
    ]);
  });
});

describe('guardrails (design §7.8)', () => {
  it('drops a number the note never said, so the page asks instead', async () => {
    const note = 'Some friends are coming to stay with us next week.';
    const made: ModelProvider = {
      ...recorded,
      answer: async () => ({
        json: { facts: [{ ...NOTES[1].answer.facts[0], count: 4 }], questions: [] },
        model: 'recorded',
        inputTokens: 0,
        outputTokens: 0,
      }),
    };
    const id = await request(note);
    await runAiRequest(deps({ providers: { allowance: made } }), id);
    const p = (await outcome(id)).result.proposals[0];
    expect(p.fact).toBeNull();
    expect(p.missing.map((m: { field: string }) => m.field)).toContain('count');
  });

  it('sends the model no private details, whatever wrote the row', async () => {
    let seen = '';
    const spy: ModelProvider = {
      ...recorded,
      answer: async (_system, user) => {
        seen = user;
        return { json: { facts: [], questions: [] }, model: 'recorded', inputTokens: 0, outputTokens: 0 };
      },
    };
    const id = await request('We are 4. Call 98765 43210 or mail a@b.com');
    await runAiRequest(deps({ providers: { allowance: spy } }), id);
    expect(seen).toContain('We are 4. Call [removed] or mail [removed]');
    expect(seen).not.toMatch(/98765|a@b[.]com/);
  });

  it('clears the note once read', async () => {
    const id = await request('3 friends are staying with us from Tuesday for a week.');
    await runAiRequest(deps(), id);
    expect((await db.query('select text from ai_requests where id = $1', [id])).rows[0].text).toBeNull();
  });

  it(`forgets the proposals after ${AI_RESULT_KEEP_DAYS} days`, async () => {
    const id = await request('3 friends are staying with us from Tuesday for a week.');
    await runAiRequest(deps(), id);
    const fresh = await request('Hello');
    await runAiRequest(deps(), fresh);
    await db.query(`update ai_requests set created_at = now() - make_interval(days => $2) where id = $1`, [id, AI_RESULT_KEEP_DAYS + 1]);
    await forgetOldAiResults(db);
    const rows = (await db.query('select id, result, context from ai_requests')).rows;
    expect(rows.find((r) => r.id === id)).toMatchObject({ result: null, context: null });
    expect(rows.find((r) => r.id === fresh).result).not.toBeNull();
  });

  it('stops every call while the AI is switched off, own keys too', async () => {
    const id = await request('Hello');
    await runAiRequest(deps({ ai: { ...ai, enabled: false } }), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'paused' });
    expect((await db.query('select 1 from ai_calls')).rowCount).toBe(0);
  });

  it("stops at the site's monthly budget on our key", async () => {
    const other = (await db.query<{ id: string }>(`insert into households (name, timezone) values ('Other', 'Asia/Kolkata') returning id`)).rows[0].id;
    await db.query(
      `insert into ai_calls (household_id, provider, model, key_source, ok, created_at)
       select $1, 'openai', 'gpt-4.1-mini', 'allowance', true, $2 from generate_series(1, $3)`,
      [other, NOW, AI_SITE_FREE_CALLS_PER_MONTH],
    );
    const id = await request('Hello');
    await runAiRequest(deps(), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'allowance_used' });
  });
});

describe('when the model misbehaves', () => {
  it('refuses an answer outside the shape, and stores nothing of it', async () => {
    const odd: ModelProvider = { name: 'anthropic', model: 'claude-opus-5', answer: async () => ({ json: { facts: [{ kind: 'party' }], questions: [] }, model: 'claude-opus-5', inputTokens: 900, outputTokens: 40 }) };
    const id = await request('Hello');
    await runAiRequest(deps({ providers: { allowance: odd } }), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'unreadable', result: null });
    // The call still counts: it was made and paid for.
    expect((await db.query('select input_tokens, ok from ai_calls where request_id = $1', [id])).rows).toEqual([{ input_tokens: 900, ok: true }]);
  });

  it('records a provider that is down', async () => {
    const down: ModelProvider = { name: 'anthropic', model: 'claude-opus-5', answer: async () => { throw new ProviderError('provider_down'); } };
    const id = await request('Hello');
    await runAiRequest(deps({ providers: { allowance: down } }), id);
    expect(await outcome(id)).toMatchObject({ status: 'failed', error_code: 'provider_down' });
    expect((await db.query('select ok from ai_calls where request_id = $1', [id])).rows).toEqual([{ ok: false }]);
  });
});
