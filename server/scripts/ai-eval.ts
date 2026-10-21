// The accuracy set against a LIVE model (design §7.8): sends each note in
// tests/fixtures/ai/notes.ts to the provider named by LLM_PROVIDER, runs its
// answer through the same reader and resolver as the worker, and compares the
// facts with what they should be. Costs real money (a few cents with Claude
// Opus; less with OpenAI's small models) — run it deliberately.
//
//   npx tsx --env-file=../.env scripts/ai-eval.ts            (from server/)
//
// Prints each note: PASS, or what differed, plus the tokens and cost.
import { FACTS_SYSTEM_PROMPT, factsUserMessage } from '../src/ai/prompt.js';
import { resolveAnswer, type ResolveContext } from '../src/ai/resolve.js';
import { readAnswer } from '../src/ai/schema.js';
import { costUsd } from '../src/api/ai.js';
import { loadConfig } from '../src/config.js';
import { allowanceProvider } from '../src/worker/ai.js';
import { NOTES, NOTES_FACTS, NOTES_ITEMS, NOTES_TODAY } from '../tests/fixtures/ai/notes.js';

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgres://unused' });
const provider = allowanceProvider(config.ai);
if (!provider) throw new Error('Set LLM_PROVIDER (openai or anthropic) and its API key in .env first.');

const people = NOTES_FACTS.filter((f) => f.kind === 'people');
const pets = NOTES_FACTS.filter((f) => f.kind === 'pets');
const ctx: ResolveContext = {
  today: NOTES_TODAY,
  items: [...NOTES_ITEMS],
  measures: [],
  peopleOn: (day) => [...people].reverse().find((f) => f.startsOn <= day)?.details.count ?? null,
  petsOn: (day) => [...pets].reverse().find((f) => f.startsOn <= day)?.details ?? null,
};
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${NOTES_TODAY}T00:00:00Z`));

let pass = 0;
let input = 0;
let output = 0;
for (const n of NOTES) {
  const user = factsUserMessage(n.note, { today: NOTES_TODAY, weekday, items: NOTES_ITEMS.map((i) => i.id), people: ctx.peopleOn(NOTES_TODAY) });
  const problems: string[] = [];
  try {
    const reply = await provider.answer(FACTS_SYSTEM_PROMPT, user);
    input += reply.inputTokens;
    output += reply.outputTokens;
    const { proposals, questions } = resolveAnswer(readAnswer(reply.json), ctx);
    if (proposals.length !== n.expect.length) problems.push(`${proposals.length} facts, expected ${n.expect.length}`);
    n.expect.forEach((want, i) => {
      const got = proposals[i];
      if (!got) return;
      if ('fact' in want) {
        if (!got.fact) problems.push(`#${i + 1}: not complete (asks ${got.missing.map((m) => m.field).join(', ') || got.problem})`);
        else {
          for (const [k, v] of Object.entries(want.fact)) {
            const actual = (got.fact as unknown as Record<string, unknown>)[k];
            if (JSON.stringify(actual) !== JSON.stringify(v)) problems.push(`#${i + 1} ${k}: ${JSON.stringify(actual)}, expected ${JSON.stringify(v)}`);
          }
        }
      } else {
        const asked = got.missing.map((m) => m.field);
        if (JSON.stringify(asked) !== JSON.stringify(want.missing)) problems.push(`#${i + 1}: asks ${JSON.stringify(asked)}, expected ${JSON.stringify(want.missing)}`);
      }
    });
    if (n.questions && !questions.length) problems.push('asked nothing back');
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  if (!problems.length) pass++;
  console.log(`${problems.length ? 'DIFF' : 'PASS'}  ${n.note}${problems.length ? `\n      ${problems.join('\n      ')}` : ''}`);
}
const usd = costUsd(provider.model, input, output);
console.log(`\n${pass}/${NOTES.length} as expected · ${provider.name} ${provider.model} · ${input} tokens in, ${output} out${usd === null ? '' : ` · $${usd.toFixed(4)}`}`);
