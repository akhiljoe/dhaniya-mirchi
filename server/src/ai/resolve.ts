// From what the model picked out to facts the household can confirm (design
// §7.8, §9.12). Every number here is computed in code: dates from "3 months
// ago" or "for a week", the head count after "my in-laws moved in", the daily
// amount from "half a glass, twice a day, for 2 people". What code can't
// know without asking — a glass's size, an end date, how many live here —
// comes back as a question on the proposal, never a guess. Pure.
import { validateFact, type FactInput } from '../api/facts.js';
import { AI_DEFAULT_STAY_DAYS, FACT_MAX_DAYS_BACK } from '../constants.js';
import { HttpError } from '../http.js';
import { WEEKDAYS, type DateRef, type ModelAnswer, type ModelFact } from './schema.js';

export type Unit = 'ml' | 'g' | 'piece';

export interface ResolveContext {
  today: string; // YYYY-MM-DD, the household's local date
  items: { id: string; unit: Unit }[]; // the household's items (canonical names)
  measures: { measure: string; unit: Unit; amount: number }[]; // the household's own ("glass" = 250 ml)
  peopleOn: (day: string) => number | null; // who lived here on a day, from the facts so far
  petsOn: (day: string) => { dogs: number; cats: number; other: number } | null; // the pets then
}

// What the page must ask before the fact can be confirmed.
export type Missing =
  | { field: 'endsOn'; suggested: string }
  // The amount's parts ride along: once the page learns the measure's size it
  // computes quantity × size × timesPerDay × persons itself, in code.
  | { field: 'measure'; measure: string; unit: Unit; quantity: number; timesPerDay: number; persons: number }
  | { field: 'count' }
  | { field: 'item'; said: string | null };

export interface Proposal {
  said: string;
  // The fact as far as it is known, for the page's edit form.
  draft: { kind: FactInput['kind']; startsOn: string; endsOn: string | null; details: Record<string, unknown>; said: string | null };
  fact: FactInput | null; // complete and checked: ready to confirm
  missing: Missing[];
  problem: string | null; // why it can't be used as read (the page shows it)
}

// ---- Dates -----------------------------------------------------------------------

const DAY = 86_400_000;
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => toDay(parse(d) + n * DAY);
function addMonths(d: string, n: number): string {
  const x = new Date(parse(d));
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return toDay(x.getTime());
}
const shift = (d: string, n: number, unit: 'day' | 'week' | 'month') => (unit === 'month' ? addMonths(d, n) : addDays(d, unit === 'week' ? 7 * n : n));

// A date as said, on the household's calendar. "Tuesday" is the next Tuesday
// after today; "last Sunday" the last one before it.
export function resolveDate(ref: DateRef, today: string): string {
  switch (ref.kind) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'yesterday':
      return addDays(today, -1);
    case 'date':
      return ref.date!;
    case 'ago':
      return shift(today, -ref.n!, ref.unit!);
    case 'ahead':
      return shift(today, ref.n!, ref.unit!);
    case 'weekday':
    case 'last_weekday': {
      const now = (new Date(parse(today)).getUTCDay() + 6) % 7; // Monday = 0
      const want = WEEKDAYS.indexOf(ref.weekday!);
      return ref.kind === 'weekday' ? addDays(today, ((want - now + 7) % 7) || 7) : addDays(today, -(((now - want + 7) % 7) || 7));
    }
  }
}

// ---- Amounts ------------------------------------------------------------------------

// Fixed conversions to the canonical units (design §8.2).
const FIXED: Record<string, { unit: Unit; factor: number }> = {
  ml: { unit: 'ml', factor: 1 },
  milliliter: { unit: 'ml', factor: 1 },
  millilitre: { unit: 'ml', factor: 1 },
  l: { unit: 'ml', factor: 1000 },
  liter: { unit: 'ml', factor: 1000 },
  litre: { unit: 'ml', factor: 1000 },
  g: { unit: 'g', factor: 1 },
  gm: { unit: 'g', factor: 1 },
  gram: { unit: 'g', factor: 1 },
  kg: { unit: 'g', factor: 1000 },
  kilo: { unit: 'g', factor: 1000 },
  kilogram: { unit: 'g', factor: 1000 },
  piece: { unit: 'piece', factor: 1 },
  pc: { unit: 'piece', factor: 1 },
  pcs: { unit: 'piece', factor: 1 },
  no: { unit: 'piece', factor: 1 },
  nos: { unit: 'piece', factor: 1 },
};
// "glasses" → "glass", "cups" → "cup", "litres" → "litre".
const singular = (m: string) => [m, m.replace(/es$/, ''), m.replace(/s$/, '')];

// The canonical amount one `measure` is, for an item in `unit`; null = ask.
// A counted item ("2 boiled eggs") counts in pieces whatever noun was used.
export function measureFactor(measure: string, unit: Unit, own: ResolveContext['measures']): number | null {
  for (const m of singular(measure.trim().toLowerCase())) {
    const fixed = FIXED[m];
    if (fixed) return fixed.unit === unit ? fixed.factor : null;
    const learned = own.find((x) => x.measure === m && x.unit === unit);
    if (learned) return learned.amount;
  }
  return unit === 'piece' ? 1 : null;
}

// ---- Facts ----------------------------------------------------------------------------

function matchItem(said: string | null, items: ResolveContext['items']) {
  if (!said) return null;
  return items.find((i) => i.id === said) ?? items.find((i) => said.includes(i.id) || i.id.includes(said)) ?? null;
}

function resolveOne(f: ModelFact, ctx: ResolveContext): Proposal {
  const always = addDays(ctx.today, -(FACT_MAX_DAYS_BACK - 1));
  const missing: Missing[] = [];
  // People joining for a while are guests, whatever the model called them.
  const temporary = f.kind === 'people' && (f.ends || f.lasts) && f.peopleJoining;
  const kind = temporary ? 'guests' : f.kind;
  const openByDefault = kind === 'people' || kind === 'pets' || kind === 'regular_use';
  const startsOn = f.starts ? resolveDate(f.starts, ctx.today) : openByDefault ? always : ctx.today;
  let endsOn: string | null = f.ends ? resolveDate(f.ends, ctx.today) : f.lasts ? addDays(shift(startsOn, f.lasts.n, f.lasts.unit), -1) : null;

  let details: Record<string, unknown> = {};
  switch (kind) {
    case 'people': {
      let count = f.count;
      if (count === null && (f.peopleJoining || f.peopleLeaving)) {
        const before = ctx.peopleOn(addDays(startsOn, -1));
        if (before === null) missing.push({ field: 'count' });
        else count = before + (f.peopleJoining ?? 0) - (f.peopleLeaving ?? 0);
      }
      if (count === null && !missing.length) missing.push({ field: 'count' });
      details = { count };
      endsOn = null;
      break;
    }
    case 'guests': {
      const count = f.count ?? f.peopleJoining;
      if (count === null) missing.push({ field: 'count' });
      if (endsOn === null) missing.push({ field: 'endsOn', suggested: addDays(startsOn, AI_DEFAULT_STAY_DAYS - 1) });
      details = { count };
      break;
    }
    case 'pets': {
      // A pets fact holds every count; a kind not mentioned keeps its count
      // ("we got a cat" must not drop the dogs).
      const now = ctx.petsOn(startsOn) ?? { dogs: 0, cats: 0, other: 0 };
      details = { dogs: f.dogs ?? now.dogs, cats: f.cats ?? now.cats, other: f.otherPets ?? now.other };
      endsOn = null;
      break;
    }
    case 'regular_use': {
      const item = matchItem(f.item, ctx.items);
      if (!item) missing.push({ field: 'item', said: f.item });
      let perDay: number | null = null;
      if (f.amount && item) {
        const factor = measureFactor(f.amount.measure, item.unit, ctx.measures);
        if (factor === null) {
          const { quantity, timesPerDay, persons } = f.amount;
          missing.push({ field: 'measure', measure: f.amount.measure, unit: item.unit, quantity, timesPerDay, persons });
        }
        else perDay = Math.round(f.amount.quantity * factor * f.amount.timesPerDay * f.amount.persons * 100) / 100;
      }
      details = { item: item?.id ?? f.item, for: f.forWhom ?? 'people', perDay, unit: perDay === null ? null : item!.unit };
      break;
    }
    case 'away':
      details = {};
      break;
  }

  const draft = { kind, startsOn, endsOn, details, said: f.said || null };
  let fact: FactInput | null = null;
  let problem: string | null = null;
  if (!missing.length) {
    try {
      fact = validateFact(draft, ctx.today);
    } catch (err) {
      problem = err instanceof HttpError ? err.message : 'That could not be read.';
    }
  }
  return { said: f.said, draft, fact, missing, problem };
}

export function resolveAnswer(answer: ModelAnswer, ctx: ResolveContext): { proposals: Proposal[]; questions: string[] } {
  return { proposals: answer.facts.map((f) => resolveOne(f, ctx)), questions: answer.questions };
}
