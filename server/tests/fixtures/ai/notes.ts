// The accuracy set for reading households' words (design §7.8): real-style
// notes, most in the household's own words (2026-09-19), each with
//  - `answer`: what the model should pick out — written here by Claude as the
//    model, so the tests run with no live call ("recorded" provider);
//  - `expect`: what the whole pipeline (read → resolve → check) must give.
// scripts/ai-eval.ts sends the same notes to a live provider and compares its
// facts with `expect`.
//
// The household behind every note: today is Saturday 2026-09-19; 2 people
// lived here until 2026-06-18 and 4 since; 2 dogs; no measures learned yet.
import type { DateRef, ModelAnswer, ModelFact } from '../../../src/ai/schema.js';

export const NOTES_TODAY = '2026-09-19';
export const NOTES_ITEMS = [
  { id: 'milk', unit: 'ml' },
  { id: 'eggs', unit: 'piece' },
  { id: 'carrot', unit: 'g' },
  { id: 'pumpkin', unit: 'g' },
  { id: 'curd', unit: 'g' },
  { id: 'coconut oil', unit: 'ml' },
  { id: 'paneer', unit: 'g' },
  { id: 'bread', unit: 'g' },
  { id: 'dog food', unit: 'g' },
] as const;
export const NOTES_FACTS = [
  { kind: 'people', startsOn: '2023-09-21', details: { count: 2 } },
  { kind: 'people', startsOn: '2026-06-19', details: { count: 4 } },
  { kind: 'pets', startsOn: '2023-09-21', details: { dogs: 2, cats: 0, other: 0 } },
] as const;

const d = (kind: DateRef['kind'], o: Partial<DateRef> = {}): DateRef => ({ kind, date: null, n: null, unit: null, weekday: null, ...o });
const f = (o: Partial<ModelFact> & Pick<ModelFact, 'kind' | 'said'>): ModelFact => ({
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
  ...o,
});

// What each proposal must come to: a complete fact, or the questions it must ask.
export type Expected =
  | { fact: { kind: string; startsOn?: string; endsOn?: string | null; details: Record<string, unknown> } }
  | { missing: string[] }; // the fields to ask about

export interface Note {
  note: string;
  answer: ModelAnswer;
  expect: Expected[];
  questions?: boolean; // the model must ask something back
}

export const NOTES: Note[] = [
  {
    note: 'My mother-in-law and brother-in-law have been living with us for 3-4 months now.',
    answer: { facts: [f({ kind: 'people', peopleJoining: 2, starts: d('ago', { n: 3, unit: 'month' }), said: 'My mother-in-law and brother-in-law have been living with us for 3-4 months now.' })], questions: [] },
    // Code does the sum: 2 lived here the day before, 2 joined → 4.
    expect: [{ fact: { kind: 'people', startsOn: '2026-06-19', endsOn: null, details: { count: 4 } } }],
  },
  {
    note: 'Some friends are coming to stay with us next week.',
    answer: {
      facts: [f({ kind: 'guests', starts: d('ahead', { n: 1, unit: 'week' }), said: 'Some friends are coming to stay with us next week.' })],
      questions: ['How many friends are coming, and until when are they staying?'],
    },
    expect: [{ missing: ['count', 'endsOn'] }],
    questions: true,
  },
  {
    note: '3 friends are staying with us from Tuesday for a week.',
    answer: { facts: [f({ kind: 'guests', count: 3, starts: d('weekday', { weekday: 'tuesday' }), lasts: { n: 1, unit: 'week' }, said: '3 friends are staying with us from Tuesday for a week.' })], questions: [] },
    expect: [{ fact: { kind: 'guests', startsOn: '2026-09-22', endsOn: '2026-09-28', details: { count: 3 } } }],
  },
  {
    note: 'My dogs generally eat carrot, pumpkin, curd, coconut oil and 1 boiled egg each, usually every day.',
    answer: {
      facts: [
        f({ kind: 'regular_use', item: 'eggs', forWhom: 'pets', amount: { quantity: 1, measure: 'boiled egg', timesPerDay: 1, persons: 2 }, said: '1 boiled egg each, usually every day' }),
        f({ kind: 'regular_use', item: 'carrot', forWhom: 'pets', said: 'My dogs generally eat carrot' }),
        f({ kind: 'regular_use', item: 'pumpkin', forWhom: 'pets', said: 'pumpkin' }),
        f({ kind: 'regular_use', item: 'curd', forWhom: 'pets', said: 'curd' }),
        f({ kind: 'regular_use', item: 'coconut oil', forWhom: 'pets', said: 'coconut oil' }),
      ],
      questions: [],
    },
    // "1 each" for 2 dogs is 2 a day — multiplied in code.
    expect: [
      { fact: { kind: 'regular_use', details: { item: 'eggs', for: 'pets', perDay: 2, unit: 'piece' } } },
      { fact: { kind: 'regular_use', details: { item: 'carrot', for: 'pets', perDay: null, unit: null } } },
      { fact: { kind: 'regular_use', details: { item: 'pumpkin', for: 'pets', perDay: null, unit: null } } },
      { fact: { kind: 'regular_use', details: { item: 'curd', for: 'pets', perDay: null, unit: null } } },
      { fact: { kind: 'regular_use', details: { item: 'coconut oil', for: 'pets', perDay: null, unit: null } } },
    ],
  },
  {
    note: 'My wife and mother-in-law have tea twice a day, half a glass of milk each.',
    answer: {
      facts: [f({ kind: 'regular_use', item: 'milk', forWhom: 'people', amount: { quantity: 0.5, measure: 'glass', timesPerDay: 2, persons: 2 }, said: 'My wife and mother-in-law have tea twice a day, half a glass of milk each.' })],
      questions: [],
    },
    // A glass isn't known yet: asked once, never guessed.
    expect: [{ missing: ['measure'] }],
  },
  {
    note: "We're going to Goa from 5 October to 12 October.",
    answer: { facts: [f({ kind: 'away', starts: d('date', { date: '2026-10-05' }), ends: d('date', { date: '2026-10-12' }), said: "We're going to Goa from 5 October to 12 October." })], questions: [] },
    expect: [{ fact: { kind: 'away', startsOn: '2026-10-05', endsOn: '2026-10-12', details: {} } }],
  },
  {
    note: "Going to my parents' place tomorrow, not sure when we'll be back.",
    answer: { facts: [f({ kind: 'away', starts: d('tomorrow'), said: "Going to my parents' place tomorrow, not sure when we'll be back." })], questions: [] },
    expect: [{ fact: { kind: 'away', startsOn: '2026-09-20', endsOn: null, details: {} } }],
  },
  {
    note: 'My brother-in-law moved out last Sunday.',
    answer: { facts: [f({ kind: 'people', peopleLeaving: 1, starts: d('last_weekday', { weekday: 'sunday' }), said: 'My brother-in-law moved out last Sunday.' })], questions: [] },
    expect: [{ fact: { kind: 'people', startsOn: '2026-09-13', details: { count: 3 } } }],
  },
  {
    note: 'We got a cat last week.',
    answer: { facts: [f({ kind: 'pets', cats: 1, starts: d('ago', { n: 1, unit: 'week' }), said: 'We got a cat last week.' })], questions: [] },
    // The dogs stay.
    expect: [{ fact: { kind: 'pets', startsOn: '2026-09-12', details: { dogs: 2, cats: 1, other: 0 } } }],
  },
  {
    note: 'We use about 2 litres of milk a day.',
    answer: { facts: [f({ kind: 'regular_use', item: 'milk', forWhom: 'people', amount: { quantity: 2, measure: 'litre', timesPerDay: 1, persons: 1 }, said: 'We use about 2 litres of milk a day.' })], questions: [] },
    expect: [{ fact: { kind: 'regular_use', details: { item: 'milk', for: 'people', perDay: 2000, unit: 'ml' } } }],
  },
  {
    note: 'Hello',
    answer: { facts: [], questions: ['Tell me who lives with you, guests coming, time away, or something you use every day.'] },
    expect: [],
    questions: true,
  },
  {
    note: 'My sister and her husband are visiting for 10 days from the 1st.',
    answer: {
      facts: [f({ kind: 'guests', count: 2, starts: d('date', { date: '2026-10-01' }), lasts: { n: 10, unit: 'day' }, said: 'My sister and her husband are visiting for 10 days from the 1st.' })],
      questions: [],
    },
    expect: [{ fact: { kind: 'guests', startsOn: '2026-10-01', endsOn: '2026-10-10', details: { count: 2 } } }],
  },
];
