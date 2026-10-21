// Household facts in the browser (design §9.12): load, add, withdraw, and
// turn them into what the engine reads. Every check happens in the api; the
// dates are the household's local days, turned into instants here.
import { sizeTimeline, type AwayPeriod } from '@/engine';

import { api } from './api';
import type { HouseholdProfile } from './household';

export type FactKind = 'people' | 'guests' | 'pets' | 'regular_use' | 'away';

export interface Fact {
  id: string;
  kind: FactKind;
  startsOn: string; // YYYY-MM-DD, household-local
  endsOn: string | null; // the last day it holds; null = open
  details: {
    count?: number; // people, guests
    dogs?: number; // pets
    cats?: number;
    other?: number;
    item?: string; // regular use: the canonical item
    for?: 'people' | 'pets';
    perDay?: number | null;
    unit?: 'ml' | 'g' | 'piece' | null;
  };
  said: string | null;
  source: 'form' | 'ai' | 'suggestion';
  addedBy: string | null;
  createdAt: string;
}

export type NewFact = Pick<Fact, 'kind' | 'startsOn' | 'endsOn' | 'details' | 'said'>;

export async function fetchFacts(): Promise<Fact[]> {
  return (await api<{ facts: Fact[] }>('GET', '/api/household/facts')).facts;
}

// `source` 'ai': confirmed from an AI proposal (design §7.8), counted on the
// AI settings page.
export function addFact(f: NewFact, source: 'form' | 'ai' = 'form'): Promise<{ fact: Fact }> {
  return api('POST', '/api/household/facts', { ...f, source });
}

export function withdrawFact(id: string): Promise<unknown> {
  return api('POST', `/api/household/facts/${encodeURIComponent(id)}/withdraw`, {});
}

// ---- Dates ---------------------------------------------------------------------

const DAY = 86_400_000;
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

// How far the timezone is ahead of UTC at instant `t`, in ms.
function offsetMs(t: number, tz: string): number {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    partsFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}

// The instant a household-local day begins.
export function localMidnight(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, tz);
  return new Date(guess - offsetMs(first, tz)); // once more, for a day that changes offset
}

// The instant right after a household-local day ends (the next midnight).
export function endOfDay(day: string, tz: string): Date {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  return localMidnight(next, tz);
}

// Today as YYYY-MM-DD in the household's timezone.
export function localDay(t: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

// ---- What the engine reads -------------------------------------------------------

// Facts → the profile the engine reads: the size timeline, each item's
// regular use, and time away. Pure.
export function profileOf(facts: Fact[], tz: string): HouseholdProfile {
  const start = (f: Fact) => localMidnight(f.startsOn, tz);
  const end = (f: Fact) => (f.endsOn ? endOfDay(f.endsOn, tz) : null);
  const sizes = sizeTimeline({
    people: facts.filter((f) => f.kind === 'people').map((f) => ({ from: start(f), count: f.details.count ?? 0 })),
    pets: facts.filter((f) => f.kind === 'pets').map((f) => ({ from: start(f), count: (f.details.dogs ?? 0) + (f.details.cats ?? 0) + (f.details.other ?? 0) })),
    guests: facts.filter((f) => f.kind === 'guests' && f.endsOn).map((f) => ({ from: start(f), to: end(f)!, count: f.details.count ?? 0 })),
  });
  const regular = facts
    .filter((f) => f.kind === 'regular_use' && f.details.item)
    .map((f) => ({ item: f.details.item!, from: start(f), to: end(f), perDay: f.details.perDay ?? null }));
  const away: AwayPeriod[] = facts.filter((f) => f.kind === 'away').map((f) => ({ from: start(f), to: end(f) }));
  return { sizes, regular, away };
}

// Who lives here today, in words: "4 people, 2 dogs". null before anyone said.
export function whoLivesHere(facts: Fact[], today: string): { people: number | null; guests: number; pets: string | null } {
  const latest = (kind: FactKind) =>
    facts
      .filter((f) => f.kind === kind && f.startsOn <= today)
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.createdAt.localeCompare(b.createdAt))
      .pop() ?? null;
  const people = latest('people')?.details.count ?? null;
  const guests = facts
    .filter((f) => f.kind === 'guests' && f.startsOn <= today && (f.endsOn ?? today) >= today)
    .reduce((n, f) => n + (f.details.count ?? 0), 0);
  const p = latest('pets')?.details;
  const petParts = p
    ? [
        [p.dogs ?? 0, 'dog', 'dogs'],
        [p.cats ?? 0, 'cat', 'cats'],
        [p.other ?? 0, 'other pet', 'other pets'],
      ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    : [];
  return { people, guests, pets: petParts.length ? petParts.join(', ') : null };
}
