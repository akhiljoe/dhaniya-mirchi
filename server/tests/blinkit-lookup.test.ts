// Asking the store, before opening a single page, whether it has the thing.
//
// This decides whether the page is driven at all, so a wrong "they do not
// sell it" does not merely slow something down: it silently stops buying a
// household's food, and they find out at the door.
import { describe, expect, it } from 'vitest';

import { verdictFromSearch, type SearchHit } from '../src/worker/adapters/blinkit-page.js';

const hit = (product_name: string, inventory?: number, unit = '1 kg'): SearchHit => ({ product_name, inventory, unit });

describe('what the store says about a wanted thing', () => {
  it('says which wording found it, so the page is opened once', () => {
    const said = verdictFromSearch([{ query: 'Amul Unsalted Butter', found: [hit('Amul Unsalted Butter', 4)] }], 'Amul Unsalted Butter');
    expect(said).toEqual({ query: 'Amul Unsalted Butter' });
  });

  it('tells out of stock apart from not carried', () => {
    // Real: the store lists Thai Guava and had none.
    expect(verdictFromSearch([{ query: 'Thai Guava', found: [hit('Thai Guava', 0)] }], 'Thai Guava')).toBe('out_of_stock');
    // Real: a search for Yellaki Banana comes back apples and Robusta.
    expect(
      verdictFromSearch([{ query: 'Yellaki Banana', found: [hit('Everyday Apple', 14), hit('Premium Robusta Banana', 6)] }], 'Yellaki Banana'),
    ).toBe('not_listed');
  });

  it('concludes NOTHING when the store could not be asked', () => {
    // The one answer that must never become "they do not sell it".
    expect(verdictFromSearch([{ query: 'Amul Butter', found: null }], 'Amul Butter')).toBeNull();
    expect(verdictFromSearch([], 'Amul Butter')).toBeNull();
  });

  it('an empty answer is evidence, a missing one is not', () => {
    expect(verdictFromSearch([{ query: 'Amul Butter', found: [] }], 'Amul Butter')).toBe('not_listed');
  });

  it('treats a product that states no stock at all as available', () => {
    // Absent is not zero. Refusing these would stop buying things the store
    // simply does not publish a count for.
    expect(verdictFromSearch([{ query: 'Amul Butter', found: [hit('Amul Butter')] }], 'Amul Butter')).toEqual({ query: 'Amul Butter' });
  });

  it('accepts the store s own longer name, as the page matcher does', () => {
    const said = verdictFromSearch(
      [{ query: 'English Oven Sandwich Bread', found: [hit('English Oven Sandwich White Bread', 2)] }],
      'English Oven Sandwich Bread',
    );
    expect(said).toEqual({ query: 'English Oven Sandwich Bread' });
  });

  it('takes a later wording when the first found nothing', () => {
    const said = verdictFromSearch(
      [
        { query: 'Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free', found: [] },
        { query: 'Freshwrapp Aluminium Foil', found: [hit('Freshwrapp Aluminium Foil', 3)] },
      ],
      'Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free',
    );
    expect(said).toEqual({ query: 'Freshwrapp Aluminium Foil' });
  });

  it('prefers stock over a listing with none', () => {
    const said = verdictFromSearch(
      [
        { query: 'Amul Butter', found: [hit('Amul Butter', 0)] },
        { query: 'Butter', found: [hit('Amul Butter', 5)] },
      ],
      'Amul Butter',
    );
    expect(said).toEqual({ query: 'Butter' });
  });
});
