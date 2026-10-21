// The guardrails every AI call passes through (design §7.8 "Guardrails").
// The model is useful and untrusted: what goes to it is cleaned, and what
// comes back is checked against the household's own words before anyone sees
// it. Pure; the api and the worker call it.
//
// Going in (cleanNote, cleanItemName):
//  - private details are cut before the note is stored or sent: phone, card,
//    Aadhaar and other long numbers, emails, UPI IDs, links, OTPs and PINs,
//    PAN numbers, API keys. The model never needs them, and a note is kept in
//    the proposals' "your words".
//  - invisible characters (zero-width, direction overrides) are removed, so
//    what the model reads is what the person sees.
//  - the note is fenced (fenceNote) and the instructions say its words are
//    data, never instructions.
//
// Coming back (groundAnswer, cleanQuestion):
//  - a number the note never said is not used ("friends are coming" must not
//    become "2 friends"). Allowed without saying: 1 ("a cat", "my
//    mother-in-law"), 2 where the note names a pair ("my sister and her
//    husband"), 0 where it says none, and for "each" the household's own
//    head or pet count. Anything else is dropped and asked instead.
//  - "your words" must be the household's words: a quote not in the note is
//    replaced by the note itself.
//  - item and measure names must look like names; questions shown on the page
//    are plain text, short, with no links or contact details.
//
// The rest of the chain: the answer's shape is read strictly (schema.ts),
// every number is computed in code (resolve.ts), every fact passes the form's
// checks (validateFact), and nothing counts until the person confirms it.
import { AI_QUESTION_MAX_CHARS, AI_QUESTIONS_MAX } from '../constants.js';
import type { DateRef, ModelAnswer, ModelFact } from './schema.js';

// ---- Going in ------------------------------------------------------------------------

export type Removed = 'phone number' | 'long number' | 'email' | 'UPI ID' | 'link' | 'code' | 'ID number' | 'key';

// Order matters: keys and links before emails, emails before UPI IDs, codes
// ("OTP 123456") before bare long numbers.
const PRIVATE: { kind: Removed; re: RegExp }[] = [
  { kind: 'key', re: /\b(?:sk|pk|rk|sess)-[A-Za-z0-9_-]{16,}/g },
  { kind: 'link', re: /\b(?:https?:\/\/|www\.)\S+/gi },
  { kind: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { kind: 'UPI ID', re: /\b[\w.-]{2,}@[a-z]{2,}\b/gi },
  { kind: 'code', re: /\b(?:otp|pin|cvv|passcode|password|code)\b[^\d\n]{0,12}\d{3,8}\b/gi },
  { kind: 'ID number', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g }, // PAN
  { kind: 'long number', re: /\+?\d(?:[ -]?\d){5,}/g },
];
// A date written with dashes ("2026-10-05", "05-10-2026") is not private.
const DATE_LIKE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{2,4})$/;
// Zero-width, direction overrides and other controls (a newline and a tab stay).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
export const REMOVED_MARK = '[removed]';

function kindOfNumber(match: string): Removed {
  const digits = match.replace(/\D/g, '');
  if (digits.length === 10 || (digits.length === 12 && digits.startsWith('91')) || (digits.length === 11 && digits.startsWith('0'))) return 'phone number';
  return 'long number';
}

// The note as it may be stored and sent, and what was cut from it.
export function cleanNote(raw: string): { text: string; removed: Removed[] } {
  let text = raw.normalize('NFC').replace(INVISIBLE, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const removed = new Set<Removed>();
  for (const { kind, re } of PRIVATE) {
    text = text.replace(re, (m) => {
      if (kind === 'long number' && DATE_LIKE.test(m.trim())) return m;
      removed.add(kind === 'long number' ? kindOfNumber(m) : kind);
      return REMOVED_MARK;
    });
  }
  return { text, removed: [...removed] };
}

// The page sends the household's item names (the catalog lives there). They
// go into the model's instructions, so only name-like ones are kept.
const NAME = /^[a-z0-9][a-z0-9 &'()/.,+-]{0,59}$/;
export function cleanItemName(name: string): string | null {
  const n = name.normalize('NFC').replace(INVISIBLE, '').trim().toLowerCase();
  return NAME.test(n) ? n : null;
}

// The note, fenced off from the instructions. The fence can't be closed from
// inside: any tag named note is taken out of the text.
export function fenceNote(text: string): string {
  return `<note>\n${text.replace(/<\/?\s*note\b[^>]*>/gi, '')}\n</note>`;
}
export function unfenceNote(message: string): string | null {
  return message.match(/<note>\n([\s\S]*)\n<\/note>/)?.[1] ?? null;
}

// ---- Coming back ------------------------------------------------------------------------

const WORDS: Record<string, number[]> = {
  zero: [0], none: [0], no: [0],
  a: [1], an: [1], one: [1], once: [1], single: [1],
  two: [2], twice: [2], couple: [2], pair: [2], both: [2], double: [2],
  three: [3], thrice: [3], triple: [3], four: [4], five: [5], six: [6], seven: [7], eight: [8], nine: [9],
  ten: [10], eleven: [11], twelve: [12], dozen: [12], thirteen: [13], fourteen: [14], fifteen: [15],
  sixteen: [16], seventeen: [17], eighteen: [18], nineteen: [19], twenty: [20], thirty: [30], forty: [40],
  fifty: [50], hundred: [100],
  half: [0.5], quarter: [0.25],
  fortnight: [2], // "for a fortnight" → 2 weeks
};
// A pair named without a number: "my sister and her husband", "my in-laws",
// "morning and evening".
const PAIR = /\b(?:and|&|both|couple|pair|parents|in-?laws|twins|morning and evening)\b/i;
const NONE = /\b(?:no|none|zero|not|n't|anymore|any more|nobody|gone|died|passed away|left)\b|n't\b/i;

// Every number the note says, in digits ("3-4", "1st", "1/2", "2.5") or words.
export function numbersSaid(note: string): Set<number> {
  const out = new Set<number>();
  const lower = note.toLowerCase();
  for (const m of lower.matchAll(/(\d+)\s*\/\s*(\d+)/g)) if (Number(m[2]) > 0) out.add(Number(m[1]) / Number(m[2]));
  for (const m of lower.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  for (const w of lower.match(/[a-z]+/g) ?? []) for (const n of WORDS[w] ?? []) out.add(n);
  // "one and a half", "1.5", "2 and a half".
  for (const n of [...out]) if (/and a half/.test(lower) && Number.isInteger(n)) out.add(n + 0.5);
  return out;
}

export interface GroundContext {
  people: number | null; // who lives here now (for "each")
  pets: { dogs: number; cats: number; other: number } | null;
}

// What the guard did to one answer: counts only, for the log.
export interface GroundReport {
  numbersDropped: number;
  factsDropped: number;
  quotesReplaced: number;
  namesDropped: number;
  questionsDropped: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MEASURE = /^[a-z][a-z ]{0,29}$/;
const ITEM = /^[a-z][a-z0-9 &'()/.,+-]{0,59}$/;

// A question the model wrote, fit to show: plain, short, no links or contact
// details, no dashes the app's copy never uses. Null to drop it.
export function cleanQuestion(q: string): string | null {
  let t = cleanNote(q).text;
  if (t.includes(REMOVED_MARK)) return null;
  t = t.replace(/<[^>]*>/g, '').replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/[<>{}[\]`*_#|\\]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > AI_QUESTION_MAX_CHARS) return null;
  return t;
}

// The model's answer, held to the household's own words. Pure.
export function groundAnswer(answer: ModelAnswer, note: string, ctx: GroundContext): { answer: ModelAnswer; report: GroundReport } {
  const said = numbersSaid(note);
  const pair = PAIR.test(note);
  const none = NONE.test(note);
  const report: GroundReport = { numbersDropped: 0, factsDropped: 0, quotesReplaced: 0, namesDropped: 0, questionsDropped: 0 };
  const asks: string[] = [];

  // Whether `n` was said, or needs no saying. `pairs`: 2 may stand for a
  // pair the note names; `own`: numbers the household's own counts allow.
  const ok = (n: number, pairs: boolean, own: number[] = []) =>
    said.has(n) || n === 1 || (n === 0 && none) || (n === 2 && pairs && pair) || own.includes(n);
  const keep = <T extends number | null>(n: T, pairs: boolean, own: number[] = []): T | null => {
    if (n === null || ok(n, pairs, own)) return n;
    report.numbersDropped++;
    return null;
  };
  // A date as said: its count ("3 months ago") or its day ("5 October").
  const dateOk = (r: DateRef | null) => {
    if (!r) return true;
    if ((r.kind === 'ago' || r.kind === 'ahead') && r.n !== null) return ok(r.n, false);
    if (r.kind === 'date' && r.date) return said.has(Number(r.date.slice(8, 10)));
    return true;
  };

  const heads = [ctx.people, ctx.pets?.dogs, ctx.pets?.cats, ctx.pets?.other, ctx.pets ? ctx.pets.dogs + ctx.pets.cats + ctx.pets.other : null].filter(
    (n): n is number => typeof n === 'number' && n > 0,
  );

  const facts: ModelFact[] = [];
  for (const f0 of answer.facts) {
    const f = { ...f0 };
    // A start the note didn't say is worse than none: the fact is asked again.
    if (!dateOk(f.starts)) {
      report.factsDropped++;
      asks.push('When did that start? Say it with a date, like "since 3 June".');
      continue;
    }
    if (!dateOk(f.ends)) {
      report.numbersDropped++;
      f.ends = null; // the page asks until when, with a default
    }
    if (f.lasts && !ok(f.lasts.n, false)) {
      report.numbersDropped++;
      f.lasts = null;
    }
    f.count = keep(f.count, true);
    f.peopleJoining = keep(f.peopleJoining, true);
    f.peopleLeaving = keep(f.peopleLeaving, true);
    const petsBefore = [f.dogs, f.cats, f.otherPets].filter((n) => n !== null).length;
    f.dogs = keep(f.dogs, true);
    f.cats = keep(f.cats, true);
    f.otherPets = keep(f.otherPets, true);
    if (f.kind === 'pets' && petsBefore > 0 && f.dogs === null && f.cats === null && f.otherPets === null) {
      report.factsDropped++;
      asks.push('How many pets do you have now?');
      continue;
    }
    if (f.item !== null && !ITEM.test(f.item)) {
      report.namesDropped++;
      f.item = null; // the page asks which item
    }
    if (f.amount) {
      const a = f.amount;
      const grounded = ok(a.quantity, false) && ok(a.timesPerDay, true) && ok(a.persons, true, heads) && MEASURE.test(a.measure);
      if (!grounded) {
        report.numbersDropped++;
        f.amount = null; // kept as "every day"
        asks.push(`How much ${f.item ?? 'of it'} a day? Say it with the amount, like "half a litre a day".`);
      }
    }
    if (!norm(note).includes(norm(f.said)) || !norm(f.said)) {
      report.quotesReplaced++;
      f.said = note;
    }
    facts.push(f);
  }

  const questions: string[] = [];
  for (const q of [...answer.questions, ...asks]) {
    const c = cleanQuestion(q);
    if (c === null) report.questionsDropped++;
    else if (!questions.includes(c)) questions.push(c);
  }
  return { answer: { facts, questions: questions.slice(0, AI_QUESTIONS_MAX) }, report };
}
