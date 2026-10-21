// The AI layer in the browser (design §7.8, §19): send a note, follow it,
// confirm what comes back, and the AI settings page's numbers. The model
// only reads words into proposals; every number is computed in code (on the
// server, or here for a measure the household just defined).
import { api } from './api';
import type { NewFact } from './facts';

export type Unit = 'ml' | 'g' | 'piece';

export type Missing =
  | { field: 'endsOn'; suggested: string }
  | { field: 'measure'; measure: string; unit: Unit; quantity: number; timesPerDay: number; persons: number }
  | { field: 'count' }
  | { field: 'item'; said: string | null };

export interface Proposal {
  said: string;
  draft: NewFact;
  fact: NewFact | null; // complete and checked by the server
  missing: Missing[];
  problem: string | null;
}

export interface ParseResult {
  proposals: Proposal[];
  questions: string[];
  provider: string;
  model: string;
}

export interface AiRequest {
  status: 'requested' | 'running' | 'done' | 'failed';
  result: ParseResult | { checked: true } | null;
  errorCode: string | null;
}

// What the server cut from a note before sending it ("phone number", "email"...).
export function sendNote(text: string, items: { id: string; unit: Unit }[]): Promise<{ id: string; removed: string[] }> {
  return api('POST', '/api/ai/parse', { text, items });
}

export function getRequest(id: string): Promise<AiRequest> {
  return api('GET', `/api/ai/requests/${encodeURIComponent(id)}`);
}

export function saveOutcome(id: string, confirmed: number, discarded: number): Promise<unknown> {
  return api('POST', `/api/ai/requests/${encodeURIComponent(id)}/outcome`, { confirmed, discarded });
}

export function saveMeasure(measure: string, unit: Unit, amount: number): Promise<unknown> {
  return api('POST', '/api/household/measures', { measure, unit, amount });
}

// Plain sentences for the codes a request can end with.
export const AI_ERROR_TEXT: Record<string, string> = {
  no_ai: 'The AI is off here. Use the forms below, or add your own key in AI settings.',
  paused: 'The AI is paused on this site for now. Use the forms below.',
  allowance_used: "This month's free uses are used up. Use the forms, or add your own key in AI settings.",
  key_rejected: 'OpenAI refused your key, so it was removed. Add a working one in AI settings.',
  provider_down: "The AI didn't answer just now. Please try again in a minute.",
  unreadable: "That didn't come back in a form we could use. Try saying it another way.",
  refused: "The AI wouldn't read that one. Try saying it another way.",
};
export const AI_ERROR_FALLBACK = 'Something went wrong. Please try again.';

// A daily amount once the household says how big its measure is: code, not
// the model (design §7.8).
export function perDayFrom(m: Extract<Missing, { field: 'measure' }>, size: number): number {
  return Math.round(m.quantity * size * m.timesPerDay * m.persons * 100) / 100;
}

// ---- AI settings (design §19) -----------------------------------------------------

export interface Usage {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  inr: number | null;
  onOwnKey: number;
}

export interface AiSettings {
  available: boolean;
  paused: boolean; // switched off for the whole site
  limits: { perUserHour: number; perHouseholdDay: number; keepDays: number };
  model: string | null;
  ownKey: { provider: string; last4: string; checked: boolean; addedAt: string } | null;
  allowance: { used: number; limit: number; resetsOn: string } | null;
  estimate: { calls: number; inputTokens: number; outputTokens: number; usd: number | null; inr: number | null; model: string; prices: [number, number] | null };
  usage: { month: Usage; days30: Usage };
  value: { messages: number; facts: number; questions: number; confirmed: number; discarded: number };
}

export function fetchAiSettings(): Promise<AiSettings> {
  return api('GET', '/api/ai/settings');
}

export function saveKey(key: string): Promise<{ checkId: string; last4: string }> {
  return api('POST', '/api/ai/key', { key });
}

export function removeKey(): Promise<unknown> {
  return api('POST', '/api/ai/key/remove', {});
}

// ₹12.40 → "₹12"; under a rupee → "under ₹1". Costs here are small.
export function rupees(inr: number | null): string {
  if (inr === null) return 'not known';
  if (inr < 1) return 'under ₹1';
  return `₹${Math.round(inr).toLocaleString('en-IN')}`;
}
