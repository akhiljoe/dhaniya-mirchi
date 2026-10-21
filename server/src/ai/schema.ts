// What the model may answer when it reads a household's words (design §7.8,
// §9.12), and the strict reader for it. The model only picks out parts: which
// kind of fact, which item, the numbers as said, dates as said ("3 months
// ago", "next Tuesday", "for a week"). It never adds, multiplies or counts
// days — resolve.ts does, in code.
//
// Every property is required and nullable where it may be absent, and every
// object closed (additionalProperties: false): both providers' strict JSON
// modes need that shape. The reader checks it again anyway — a provider's
// promise is not a validation.

export const FACT_KINDS = ['people', 'guests', 'pets', 'regular_use', 'away'] as const;
export const DATE_KINDS = ['today', 'tomorrow', 'yesterday', 'date', 'ago', 'ahead', 'weekday', 'last_weekday'] as const;
export const SPAN_UNITS = ['day', 'week', 'month'] as const;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

// A date as the person said it.
export interface DateRef {
  kind: (typeof DATE_KINDS)[number];
  date: string | null; // 'date': YYYY-MM-DD, only when a calendar date was said
  n: number | null; // 'ago' / 'ahead': how many units
  unit: (typeof SPAN_UNITS)[number] | null;
  weekday: (typeof WEEKDAYS)[number] | null; // 'weekday': the next such day; 'last_weekday': the last one
}

export interface ModelFact {
  kind: (typeof FACT_KINDS)[number];
  starts: DateRef | null; // null: not said
  ends: DateRef | null; // the last day, as said
  lasts: { n: number; unit: (typeof SPAN_UNITS)[number] } | null; // "for a week"
  count: number | null; // people or guests, when a total was said
  peopleJoining: number | null; // "my in-laws moved in" = 2
  peopleLeaving: number | null;
  dogs: number | null;
  cats: number | null;
  otherPets: number | null;
  item: string | null; // regular use: one of the household's item names if it fits
  forWhom: 'people' | 'pets' | null;
  // Regular use, as said: "half a glass, twice a day, for 2 people".
  amount: { quantity: number; measure: string; timesPerDay: number; persons: number } | null;
  said: string; // the words this fact came from
}

export interface ModelAnswer {
  facts: ModelFact[];
  questions: string[]; // what the model could not tell from the words
}

const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const dateRef = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'date', 'n', 'unit', 'weekday'],
  properties: {
    kind: { type: 'string', enum: [...DATE_KINDS] },
    date: nullable({ type: 'string' }),
    n: nullable({ type: 'integer' }),
    unit: nullable({ type: 'string', enum: [...SPAN_UNITS] }),
    weekday: nullable({ type: 'string', enum: [...WEEKDAYS] }),
  },
};

export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'questions'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'starts', 'ends', 'lasts', 'count', 'peopleJoining', 'peopleLeaving', 'dogs', 'cats', 'otherPets', 'item', 'forWhom', 'amount', 'said'],
        properties: {
          kind: { type: 'string', enum: [...FACT_KINDS] },
          starts: nullable(dateRef),
          ends: nullable(dateRef),
          lasts: nullable({
            type: 'object',
            additionalProperties: false,
            required: ['n', 'unit'],
            properties: { n: { type: 'integer' }, unit: { type: 'string', enum: [...SPAN_UNITS] } },
          }),
          count: nullable({ type: 'integer' }),
          peopleJoining: nullable({ type: 'integer' }),
          peopleLeaving: nullable({ type: 'integer' }),
          dogs: nullable({ type: 'integer' }),
          cats: nullable({ type: 'integer' }),
          otherPets: nullable({ type: 'integer' }),
          item: nullable({ type: 'string' }),
          forWhom: nullable({ type: 'string', enum: ['people', 'pets'] }),
          amount: nullable({
            type: 'object',
            additionalProperties: false,
            required: ['quantity', 'measure', 'timesPerDay', 'persons'],
            properties: {
              quantity: { type: 'number' },
              measure: { type: 'string' },
              timesPerDay: { type: 'number' },
              persons: { type: 'integer' },
            },
          }),
          said: { type: 'string' },
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
} as const;

// ---- The strict reader ------------------------------------------------------------

export class UnreadableAnswer extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const bad = (what: string): never => {
  throw new UnreadableAnswer(what);
};
function keys(o: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`${where}: unexpected ${k}`);
  for (const k of allowed) if (!(k in o)) bad(`${where}: missing ${k}`);
}
const intOrNull = (x: unknown, where: string, min = 0, max = 1000): number | null => {
  if (x === null) return null;
  if (!Number.isInteger(x) || (x as number) < min || (x as number) > max) bad(`${where}: not a whole number in range`);
  return x as number;
};
const oneOf = <T extends string>(x: unknown, options: readonly T[], where: string): T => {
  if (!options.includes(x as T)) bad(`${where}: not one of ${options.join('|')}`);
  return x as T;
};
const text = (x: unknown, where: string, max: number): string => {
  if (typeof x !== 'string' || x.length > max) bad(`${where}: not text`);
  return (x as string).trim();
};

function readDateRef(x: unknown, where: string): DateRef | null {
  if (x === null) return null;
  if (!isObj(x)) bad(`${where}: not an object`);
  const o = x as Record<string, unknown>;
  keys(o, ['kind', 'date', 'n', 'unit', 'weekday'], where);
  const kind = oneOf(o.kind, DATE_KINDS, `${where}.kind`);
  const ref: DateRef = {
    kind,
    date: o.date === null ? null : text(o.date, `${where}.date`, 10),
    n: intOrNull(o.n, `${where}.n`, 0, 1000),
    unit: o.unit === null ? null : oneOf(o.unit, SPAN_UNITS, `${where}.unit`),
    weekday: o.weekday === null ? null : oneOf(o.weekday, WEEKDAYS, `${where}.weekday`),
  };
  if (kind === 'date' && !(ref.date && /^\d{4}-\d{2}-\d{2}$/.test(ref.date))) bad(`${where}: a date needs YYYY-MM-DD`);
  if ((kind === 'ago' || kind === 'ahead') && (ref.n === null || ref.unit === null)) bad(`${where}: ${kind} needs n and unit`);
  if ((kind === 'weekday' || kind === 'last_weekday') && ref.weekday === null) bad(`${where}: ${kind} needs a day`);
  return ref;
}

// Reads the model's answer, or throws UnreadableAnswer. Nothing half-read is
// ever used.
export function readAnswer(raw: unknown): ModelAnswer {
  if (!isObj(raw)) bad('answer: not an object');
  const r = raw as Record<string, unknown>;
  keys(r, ['facts', 'questions'], 'answer');
  if (!Array.isArray(r.facts) || r.facts.length > 10) bad('answer.facts: not a short list');
  if (!Array.isArray(r.questions) || r.questions.length > 5) bad('answer.questions: not a short list');
  const facts = (r.facts as unknown[]).map((f, i): ModelFact => {
    const where = `facts[${i}]`;
    if (!isObj(f)) bad(`${where}: not an object`);
    const o = f as Record<string, unknown>;
    keys(o, ['kind', 'starts', 'ends', 'lasts', 'count', 'peopleJoining', 'peopleLeaving', 'dogs', 'cats', 'otherPets', 'item', 'forWhom', 'amount', 'said'], where);
    let lasts: ModelFact['lasts'] = null;
    if (o.lasts !== null) {
      if (!isObj(o.lasts)) bad(`${where}.lasts: not an object`);
      const l = o.lasts as Record<string, unknown>;
      keys(l, ['n', 'unit'], `${where}.lasts`);
      lasts = { n: intOrNull(l.n, `${where}.lasts.n`, 1, 400)!, unit: oneOf(l.unit, SPAN_UNITS, `${where}.lasts.unit`) };
      if (lasts.n === null) bad(`${where}.lasts.n: missing`);
    }
    let amount: ModelFact['amount'] = null;
    if (o.amount !== null) {
      if (!isObj(o.amount)) bad(`${where}.amount: not an object`);
      const a = o.amount as Record<string, unknown>;
      keys(a, ['quantity', 'measure', 'timesPerDay', 'persons'], `${where}.amount`);
      const num = (x: unknown, k: string) => {
        if (typeof x !== 'number' || !(x > 0) || x > 10_000) bad(`${where}.amount.${k}: not a positive number`);
        return x as number;
      };
      amount = {
        quantity: num(a.quantity, 'quantity'),
        measure: text(a.measure, `${where}.amount.measure`, 30).toLowerCase(),
        timesPerDay: num(a.timesPerDay, 'timesPerDay'),
        persons: intOrNull(a.persons, `${where}.amount.persons`, 1, 30)!,
      };
      if (amount.persons === null) bad(`${where}.amount.persons: missing`);
    }
    return {
      kind: oneOf(o.kind, FACT_KINDS, `${where}.kind`),
      starts: readDateRef(o.starts, `${where}.starts`),
      ends: readDateRef(o.ends, `${where}.ends`),
      lasts,
      count: intOrNull(o.count, `${where}.count`, 0, 30),
      peopleJoining: intOrNull(o.peopleJoining, `${where}.peopleJoining`, 0, 30),
      peopleLeaving: intOrNull(o.peopleLeaving, `${where}.peopleLeaving`, 0, 30),
      dogs: intOrNull(o.dogs, `${where}.dogs`, 0, 20),
      cats: intOrNull(o.cats, `${where}.cats`, 0, 20),
      otherPets: intOrNull(o.otherPets, `${where}.otherPets`, 0, 20),
      item: o.item === null ? null : text(o.item, `${where}.item`, 60).toLowerCase(),
      forWhom: o.forWhom === null ? null : oneOf(o.forWhom, ['people', 'pets'] as const, `${where}.forWhom`),
      amount,
      said: text(o.said, `${where}.said`, 1000),
    };
  });
  const questions = (r.questions as unknown[]).map((q, i) => text(q, `questions[${i}]`, 300)).filter(Boolean);
  return { facts, questions };
}
