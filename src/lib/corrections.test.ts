// When the household's word about an estimate still speaks for the item
// (corrections.ts). It held only until the page reloaded before; now it holds
// until the item is bought again.
import { describe, expect, it } from 'vitest';

import { correctionHolds, type Correction } from './corrections';

const said = (at: string): Correction => ({ item: 'milk', kind: 'more', saidAt: at });

describe('how long a correction holds', () => {
  it('holds while nothing has been bought since it was said', () => {
    expect(correctionHolds(said('2026-09-22T10:00:00Z'), '2026-09-21T08:00:00Z')).toBe(true);
  });

  it('stops the moment the item is bought again', () => {
    // The purchase is newer evidence than the word, and the word was about
    // the stock before it.
    expect(correctionHolds(said('2026-09-22T10:00:00Z'), '2026-09-22T18:00:00Z')).toBe(false);
  });

  it('holds for an item never bought at all', () => {
    expect(correctionHolds(said('2026-09-22T10:00:00Z'), null)).toBe(true);
  });
});
