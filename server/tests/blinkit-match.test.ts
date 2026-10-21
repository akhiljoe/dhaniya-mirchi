// Which of a store's results is the thing this household buys.
//
// Both ways of getting this wrong have already put the wrong food in a real
// cart, so both are here as tests. Cheapest-under-the-word bought a pineapple
// bread roll for a cart that asked for bread; the household's name as an
// unbroken phrase then refused the bread the store actually sells, and the
// order had nothing to pay for.
import { describe, expect, it } from 'vitest';

import { coreName, extraWords, matchesWanted, searchQueries } from '../src/worker/adapters/blinkit-page.js';

describe('matching a product to what the household buys', () => {
  it('accepts the store s own name for the same thing', () => {
    // Real: wanted "English Oven Sandwich Bread", sold as "... White Bread".
    expect(matchesWanted('English Oven Sandwich White Bread400 g₹60ADD', 'English Oven Sandwich Bread')).toBe(true);
    expect(matchesWanted('English Oven Sandwich Bread 400 g ₹60 ADD', 'English Oven Sandwich Bread')).toBe(true);
  });

  it('refuses a different thing that happens to share the words', () => {
    // Every word of "Amul Butter" is in this, and it is biscuits.
    expect(matchesWanted('Amul Fresh Butter Cookies200 g₹85ADD', 'Amul Butter')).toBe(false);
    // The one that actually went in a cart.
    expect(matchesWanted('Modern Pineapple Sweet Fill Bread Roll50 g₹10ADD', 'English Oven Sandwich Bread')).toBe(false);
  });

  it('refuses a product missing a word that matters', () => {
    expect(matchesWanted('Britannia Brown Bread400 g₹55ADD', 'English Oven Sandwich Bread')).toBe(false);
    expect(matchesWanted('Amul Taaza Toned Milk500 ml₹29ADD', 'Amul Gold Full Cream Milk')).toBe(false);
  });

  it('is not fooled by the vendor s own furniture on the card', () => {
    // "ADD", "12 MINS" and the price are not part of the product's name; left
    // in, ADD becomes the head noun of every card on the page.
    expect(matchesWanted('12 MINS Amul Taaza Toned Milk 500 ml ₹29 ADD', 'Amul Taaza Toned Milk')).toBe(true);
    expect(matchesWanted('Amul Taaza Toned Milk - Pack of 2 2 x 200 ml ₹34 ADD', 'Amul Taaza Toned Milk')).toBe(true);
  });

  it('wants the head noun at the END, not merely near it', () => {
    // A trailing word changes what the thing is often enough that it is not
    // worth the risk: "... Bread Sliced" is refused and the household is told
    // it was not found, rather than sent something they did not ask for.
    expect(matchesWanted('English Oven Sandwich Bread Sliced', 'English Oven Sandwich Bread')).toBe(false);
    expect(matchesWanted('Amul Butter Cookies Crunchy', 'Amul Butter')).toBe(false);
  });

  it('counts how far a name is from the wanted one, so the closest wins', () => {
    expect(extraWords('English Oven Sandwich Bread', 'English Oven Sandwich Bread')).toBe(0);
    expect(extraWords('English Oven Sandwich White Bread', 'English Oven Sandwich Bread')).toBe(1);
    expect(extraWords('English Oven Sandwich White Bread Sliced', 'English Oven Sandwich Bread')).toBeGreaterThan(1);
  });

  it('has no opinion when there is nothing to go on', () => {
    expect(matchesWanted('', 'Amul Butter')).toBe(false);
    expect(matchesWanted('Amul Butter', '')).toBe(false);
  });
});

// Asking the store a question it will answer.
//
// Real, 2026-09-23: four of seven lines came back "not listed" for products
// this household buys on this very store, because the whole label was typed
// into the search box. The store answers "aluminium foil"; it does not answer
// "Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free".
describe('what to type into the store search', () => {
  it('asks with the household s own name first', () => {
    expect(searchQueries('Amul Unsalted Butter')[0]).toBe('Amul Unsalted Butter');
  });

  it('drops the advertisement stuck to the name', () => {
    expect(coreName('Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free')).toBe('Freshwrapp Aluminium Foil');
  });

  it('drops the vendor s asides', () => {
    expect(coreName("Nandu's Chicken Breast (Boneless)")).toBe("Nandu's Chicken Breast");
  });

  it('widens to brand and head noun when the whole label finds nothing', () => {
    const qs = searchQueries('Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free');
    expect(qs[0]).toBe('Freshwrapp Aluminium Foil (2 x 6 m) - Buy 1 Get 1 Free');
    expect(qs).toContain('Freshwrapp Aluminium Foil');
    expect(qs.length).toBeLessThanOrEqual(3);
  });

  it('never asks the same thing twice', () => {
    const qs = searchQueries('Amul Butter');
    expect(new Set(qs).size).toBe(qs.length);
  });

  it('leaves a name with nothing to strip alone', () => {
    expect(coreName('Amul Unsalted Butter')).toBe('Amul Unsalted Butter');
  });
});
