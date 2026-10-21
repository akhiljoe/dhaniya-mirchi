// From what the model picked out to facts (design §7.8, §9.12): every date,
// head count and daily amount is computed here, in code; what can't be known
// without asking comes back as a question, never a guess.
import { describe, expect, it } from 'vitest';

import { measureFactor, resolveAnswer, resolveDate, type ResolveContext } from '../src/ai/resolve.js';
import { readAnswer, UnreadableAnswer, type DateRef, type ModelFact } from '../src/ai/schema.js';

const TODAY = '2026-09-19'; // a Saturday
const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  today: TODAY,
  items: [
    { id: 'milk', unit: 'ml' },
    { id: 'eggs', unit: 'piece' },
    { id: 'carrot', unit: 'g' },
  ],
  measures: [],
  peopleOn: () => 2,
  petsOn: () => ({ dogs: 2, cats: 0, other: 0 }),
  ...over,
});
const ref = (kind: DateRef['kind'], over: Partial<DateRef> = {}): DateRef => ({ kind, date: null, n: null, unit: null, weekday: null, ...over });
const fact = (over: Partial<ModelFact>): ModelFact => ({
  kind: 'guests',
  starts: null,
  ends: null,
  lasts: null,
  count: null,
  peopleJoining: null,
  peopleLeaving: null,
  dogs: null,
  cats: null,
  otherPets: null,
  item: null,
  forWhom: null,
  amount: null,
  said: 'words',
  ...over,
});
const one = (f: ModelFact, c = ctx()) => resolveAnswer({ facts: [f], questions: [] }, c).proposals[0];

describe('dates, computed in code', () => {
  it('resolves every way a date can be said', () => {
    expect(resolveDate(ref('today'), TODAY)).toBe('2026-09-19');
    expect(resolveDate(ref('tomorrow'), TODAY)).toBe('2026-09-20');
    expect(resolveDate(ref('date', { date: '2026-10-02' }), TODAY)).toBe('2026-10-02');
    expect(resolveDate(ref('ago', { n: 3, unit: 'month' }), TODAY)).toBe('2026-06-19');
    expect(resolveDate(ref('ahead', { n: 2, unit: 'week' }), TODAY)).toBe('2026-10-03');
    expect(resolveDate(ref('weekday', { weekday: 'tuesday' }), TODAY)).toBe('2026-09-22');
    expect(resolveDate(ref('weekday', { weekday: 'saturday' }), TODAY)).toBe('2026-09-26'); // "Saturday" on a Saturday: next week
    expect(resolveDate(ref('last_weekday', { weekday: 'sunday' }), TODAY)).toBe('2026-09-13');
    expect(resolveDate(ref('last_weekday', { weekday: 'saturday' }), TODAY)).toBe('2026-09-12');
    expect(resolveDate(ref('yesterday'), TODAY)).toBe('2026-09-18');
    expect(resolveDate(ref('ago', { n: 1, unit: 'month' }), '2026-03-31')).toBe('2026-02-28'); // no Feb 31
  });
});

describe('guests', () => {
  it('"3 friends coming Tuesday for a week"', () => {
    const p = one(fact({ count: 3, starts: ref('weekday', { weekday: 'tuesday' }), lasts: { n: 1, unit: 'week' } }));
    expect(p.fact).toMatchObject({ kind: 'guests', startsOn: '2026-09-22', endsOn: '2026-09-28', details: { count: 3 } });
    expect(p.missing).toEqual([]);
  });

  it('asks until when, with a default, when no end was said', () => {
    const p = one(fact({ count: 2 }));
    expect(p.fact).toBeNull();
    expect(p.missing).toEqual([{ field: 'endsOn', suggested: '2026-09-25' }]);
    expect(p.draft).toMatchObject({ kind: 'guests', startsOn: TODAY, endsOn: null });
  });

  it('asks how many when it was not said', () => {
    expect(one(fact({ lasts: { n: 3, unit: 'day' } })).missing).toEqual([{ field: 'count' }]);
  });

  it('reads people joining for a while as guests', () => {
    const p = one(fact({ kind: 'people', peopleJoining: 2, lasts: { n: 10, unit: 'day' } }));
    expect(p.fact).toMatchObject({ kind: 'guests', details: { count: 2 } });
  });
});

describe('who lives here', () => {
  it('adds the people joining to who lived here the day before — code does the sum', () => {
    const p = one(fact({ kind: 'people', peopleJoining: 2, starts: ref('ago', { n: 3, unit: 'month' }) }), ctx({ peopleOn: (d) => (d < '2026-06-19' ? 2 : 4) }));
    expect(p.fact).toMatchObject({ kind: 'people', startsOn: '2026-06-19', endsOn: null, details: { count: 4 } });
  });

  it('asks how many live here when it never learned', () => {
    const p = one(fact({ kind: 'people', peopleJoining: 2 }), ctx({ peopleOn: () => null }));
    expect(p.fact).toBeNull();
    expect(p.missing).toEqual([{ field: 'count' }]);
  });

  it('holds from as far back as it can when no date was said', () => {
    expect(one(fact({ kind: 'people', count: 4 })).fact?.startsOn).toBe('2023-09-21');
  });
});

describe('pets', () => {
  it('"we got a cat" keeps the dogs', () => {
    expect(one(fact({ kind: 'pets', cats: 1 })).fact?.details).toEqual({ dogs: 2, cats: 1, other: 0 });
  });
});

describe('regular use', () => {
  it('"the dogs eat 2 boiled eggs a day": counted in pieces', () => {
    const p = one(fact({ kind: 'regular_use', item: 'eggs', forWhom: 'pets', amount: { quantity: 2, measure: 'boiled egg', timesPerDay: 1, persons: 1 } }));
    expect(p.fact?.details).toEqual({ item: 'eggs', for: 'pets', perDay: 2, unit: 'piece' });
  });

  it('"tea twice a day, half a glass of milk each, for 2 people": asks the glass once, then computes', () => {
    const tea = fact({ kind: 'regular_use', item: 'milk', forWhom: 'people', amount: { quantity: 0.5, measure: 'glass', timesPerDay: 2, persons: 2 } });
    const first = one(tea);
    expect(first.fact).toBeNull();
    expect(first.missing).toEqual([{ field: 'measure', measure: 'glass', unit: 'ml', quantity: 0.5, timesPerDay: 2, persons: 2 }]);

    const known = one(tea, ctx({ measures: [{ measure: 'glass', unit: 'ml', amount: 250 }] }));
    expect(known.fact?.details).toEqual({ item: 'milk', for: 'people', perDay: 500, unit: 'ml' });
  });

  it('knows fixed measures, and plurals of learned ones', () => {
    expect(measureFactor('litres', 'ml', [])).toBe(1000);
    expect(measureFactor('kg', 'g', [])).toBe(1000);
    expect(measureFactor('glasses', 'ml', [{ measure: 'glass', unit: 'ml', amount: 200 }])).toBe(200);
    expect(measureFactor('litre', 'g', [])).toBeNull(); // a volume of a weighed item: ask
  });

  it('is just "every day" without an amount, and asks which item when none fits', () => {
    expect(one(fact({ kind: 'regular_use', item: 'carrot', forWhom: 'pets' })).fact?.details).toEqual({ item: 'carrot', for: 'pets', perDay: null, unit: null });
    expect(one(fact({ kind: 'regular_use', item: 'kombucha' })).missing).toEqual([{ field: 'item', said: 'kombucha' }]);
  });
});

describe('what the page is told when a fact makes no sense', () => {
  it('passes it through the same checks as a form, and says why', () => {
    const p = one(fact({ kind: 'guests', count: 3, starts: ref('date', { date: '2026-10-05' }), ends: ref('date', { date: '2026-10-01' }) }));
    expect(p.fact).toBeNull();
    expect(p.problem).toMatch(/before the start/);
  });
});

describe('readAnswer', () => {
  const good = { facts: [{ ...fact({ count: 2, lasts: { n: 3, unit: 'day' } }) }], questions: ['How many?'] };

  it('reads a well-formed answer', () => {
    expect(readAnswer(good).facts[0]).toMatchObject({ kind: 'guests', count: 2 });
  });

  it('refuses anything outside the shape — nothing half-read is used', () => {
    expect(() => readAnswer({ facts: [] })).toThrow(UnreadableAnswer);
    expect(() => readAnswer({ ...good, extra: 1 })).toThrow(/unexpected extra/);
    expect(() => readAnswer({ facts: [{ ...good.facts[0], kind: 'party' }], questions: [] })).toThrow(/kind/);
    expect(() => readAnswer({ facts: [{ ...good.facts[0], count: 2.5 }], questions: [] })).toThrow(/whole number/);
    expect(() => readAnswer({ facts: [{ ...good.facts[0], starts: ref('ago') }], questions: [] })).toThrow(/needs n and unit/);
    expect(() => readAnswer('not json')).toThrow(UnreadableAnswer);
  });
});
