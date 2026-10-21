// The model providers, behind one interface (design §7.8, like the vendor
// adapters of §7.4): OpenAI for users (their own key, or our allowance),
// Claude for our own testing, and "recorded" for automated tests. Each asks
// for JSON in ANSWER_JSON_SCHEMA and reports the tokens it used; the caller
// still reads the answer strictly (schema.ts). Keys are secrets: never
// logged, never in an error message (§7.6).
import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema.js';

import { AI_CALL_TIMEOUT_MS, AI_MAX_OUTPUT_TOKENS } from '../constants.js';
import { unfenceNote } from './guard.js';
import { ANSWER_JSON_SCHEMA } from './schema.js';

export interface ModelReply {
  json: unknown; // the model's answer, parsed but not yet read (schema.ts reads it)
  model: string; // the model that actually answered (a fallback may have)
  inputTokens: number;
  outputTokens: number;
}

// Codes the page can explain; never the provider's own text (it may echo input).
export type ProviderErrorCode = 'key_rejected' | 'provider_down' | 'unreadable' | 'refused';
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly tokens: { input: number; output: number } = { input: 0, output: 0 }) {
    super(code);
  }
}

// A JSON Schema for an answer: an object with named properties.
export type AnswerSchema = { type: 'object'; [k: string]: unknown };

export interface ModelProvider {
  name: 'openai' | 'anthropic' | 'recorded';
  model: string;
  // `schema` is the shape the answer must have: the facts a household's note
  // gives (schema.ts), or what a dish needs (meal-schema.ts).
  answer(system: string, user: string, schema?: AnswerSchema): Promise<ModelReply>;
}

// ---- OpenAI (users) -------------------------------------------------------------------

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export function openaiProvider(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): ModelProvider {
  return {
    name: 'openai',
    model,
    async answer(system, user, schema = ANSWER_JSON_SCHEMA) {
      let res: Response;
      try {
        res = await fetchImpl(OPENAI_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            max_completion_tokens: AI_MAX_OUTPUT_TOKENS,
            // Not kept on OpenAI's side for later viewing (guardrails, design
            // §7.8). No temperature: reasoning models (gpt-5-*) refuse one.
            store: false,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
          }),
          signal: AbortSignal.timeout(AI_CALL_TIMEOUT_MS),
        });
      } catch {
        throw new ProviderError('provider_down');
      }
      if (res.status === 401 || res.status === 403) throw new ProviderError('key_rejected');
      if (!res.ok) throw new ProviderError('provider_down');
      const body = (await res.json().catch(() => null)) as {
        model?: string;
        choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const tokens = { input: body?.usage?.prompt_tokens ?? 0, output: body?.usage?.completion_tokens ?? 0 };
      const message = body?.choices?.[0]?.message;
      if (message?.refusal) throw new ProviderError('refused', tokens);
      if (!message?.content || body?.choices?.[0]?.finish_reason === 'length') throw new ProviderError('unreadable', tokens);
      let json: unknown;
      try {
        json = JSON.parse(message.content);
      } catch {
        throw new ProviderError('unreadable', tokens);
      }
      return { json, model: body?.model ?? model, inputTokens: tokens.input, outputTokens: tokens.output };
    },
  };
}

// ---- Claude (our testing) -----------------------------------------------------------------

export function anthropicProvider(apiKey: string, model: string): ModelProvider {
  const client = new Anthropic({ apiKey, timeout: AI_CALL_TIMEOUT_MS, maxRetries: 1 });
  return {
    name: 'anthropic',
    model,
    async answer(system, user, schema = ANSWER_JSON_SCHEMA) {
      let res;
      try {
        res = await client.beta.messages.parse({
          model,
          max_tokens: AI_MAX_OUTPUT_TOKENS,
          // If the model declines, the API runs the request on a fallback
          // model in the same call (the reply's model says which answered).
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: betaJSONSchemaOutputFormat(schema) },
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new ProviderError('key_rejected');
        if (err instanceof Anthropic.BadRequestError) throw new ProviderError('unreadable');
        throw new ProviderError('provider_down');
      }
      const tokens = { input: res.usage.input_tokens, output: res.usage.output_tokens };
      if (res.stop_reason === 'refusal') throw new ProviderError('refused', tokens);
      if (res.stop_reason === 'max_tokens' || res.parsed_output === null) throw new ProviderError('unreadable', tokens);
      return { json: res.parsed_output, model: res.model, inputTokens: tokens.input, outputTokens: tokens.output };
    },
  };
}

// ---- Recorded (tests) -----------------------------------------------------------------------

// Answers written down in advance, keyed by the note. No network.
export function recordedProvider(answers: Record<string, unknown>): ModelProvider {
  return {
    name: 'recorded',
    model: 'recorded',
    async answer(_system, user) {
      const note = unfenceNote(user) ?? '';
      if (!(note in answers)) throw new ProviderError('provider_down');
      return { json: answers[note], model: 'recorded', inputTokens: 0, outputTokens: 0 };
    },
  };
}
