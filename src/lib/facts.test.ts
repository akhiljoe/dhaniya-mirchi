// Household facts in the browser (design §9.12): household-local days become
// the instants the engine reads, and "who lives here" is said in words.
import { describe, expect, it } from 'vitest';

import { sizeAt } from '@/engine';

import { endOfDay, localDay, localMidnight, profileOf, whoLivesHere, type Fact } from './facts';

const TZ = 'Asia/Kolkata';
let n = 0;
const fact = (kind: Fact['kind'], startsOn: string, details: Fact['details'], endsOn: string | null = null): Fact => ({
  id: `f${++n}`,
  kind,
  startsOn,
  endsOn,
  details,
  said: null,
  source: 'form',
  addedBy: null,
  createdAt: `2026-09-19T00:00:0${n % 10}Z`,
});

describe('household-local days', () => {
  it("starts a day at the household's midnight, and ends it at the next", () => {
    expect(localMidnight('2026-06-01', TZ).toISOString()).toBe('2026-05-31T18:30:00.000Z');
    expect(endOfDay('2026-06-30', TZ).toISOString()).toBe('2026-06-30T18:30:00.000Z');
    expect(localDay(new Date('2026-09-18T20:00:00Z'), TZ)).toBe('2026-09-19');
  });

  it('handles a timezone that changes its clocks', () => {
    // New York moves to daylight time on 2026-03-08.
    expect(localMidnight('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(localMidnight('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});

describe('profileOf', () => {
  const facts = [
    fact('people', '2023-10-01', { count: 2 }),
    fact('people', '2026-06-01', { count: 4 }),
    fact('pets', '2023-10-01', { dogs: 2, cats: 0, other: 0 }),
    fact('guests', '2026-09-22', { count: 3 }, '2026-09-28'),
    fact('regular_use', '2023-10-01', { item: 'eggs', for: 'pets', perDay: 2, unit: 'piece' }),
    fact('away', '2026-10-05', {}, '2026-10-12'),
  ];
  const p = profileOf(facts, TZ);

  it('gives the engine the head count at any moment, guests included for their days', () => {
    const at = (iso: string) => new Date(iso);
    expect(sizeAt(p.sizes, at('2026-05-31T12:00:00Z'), 'people')).toBe(2);
    expect(sizeAt(p.sizes, at('2026-06-01T12:00:00Z'), 'people')).toBe(4);
    expect(sizeAt(p.sizes, at('2026-09-28T12:00:00Z'), 'people')).toBe(7); // their last day
    expect(sizeAt(p.sizes, at('2026-09-29T12:00:00Z'), 'people')).toBe(4);
    expect(sizeAt(p.sizes, at('2026-09-29T12:00:00Z'), 'pets')).toBe(2);
  });

  it("gives each item's regular use and the time away", () => {
    expect(p.regular).toEqual([{ item: 'eggs', from: localMidnight('2023-10-01', TZ), to: null, perDay: 2 }]);
    expect(p.away).toEqual([{ from: localMidnight('2026-10-05', TZ), to: endOfDay('2026-10-12', TZ) }]);
  });
});

describe('whoLivesHere', () => {
  it('says who lives here today, with guests staying now, and nothing before anyone said', () => {
    const facts = [fact('people', '2026-06-01', { count: 4 }), fact('pets', '2026-01-01', { dogs: 2 }), fact('guests', '2026-09-18', { count: 3 }, '2026-09-20')];
    expect(whoLivesHere(facts, '2026-09-19')).toEqual({ people: 4, guests: 3, pets: '2 dogs' });
    expect(whoLivesHere(facts, '2026-09-21')).toEqual({ people: 4, guests: 0, pets: '2 dogs' });
    expect(whoLivesHere([], '2026-09-19')).toEqual({ people: null, guests: 0, pets: null });
  });
});
