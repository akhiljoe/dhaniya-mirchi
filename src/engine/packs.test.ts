// Catalog pack labels → canonical quantities (design §8, Appendix C). Moved
// from the worker: quantities are engine math, so they live here.
import { describe, expect, it } from 'vitest';

import { lineQty, parsePackLabel } from './packs';

describe('parsePackLabel', () => {
  it.each([
    ['500 ml', 500, 'ml'],
    ['1 kg', 1, 'kg'],
    ['4.8 ltr', 4.8, 'l'],
    ['200 g', 200, 'g'],
    ['75 Pieces', 75, 'piece'],
    ['840 Pull', 840, 'piece'],
  ])('reads "%s"', (label, pack, unit) => {
    expect(parsePackLabel(label)).toEqual({ pack, unit });
  });

  it('folds multipacks into one pack', () => {
    expect(parsePackLabel('330 ml x 2')).toEqual({ pack: 660, unit: 'ml' });
    expect(parsePackLabel('100 g x 3')).toEqual({ pack: 300, unit: 'g' });
    expect(parsePackLabel('1 ltr x 2')).toEqual({ pack: 2, unit: 'l' });
  });

  it('reads countable catalog units as pieces — read, not guessed', () => {
    expect(parsePackLabel('1 Bunch')).toEqual({ pack: 1, unit: 'piece' });
    expect(parsePackLabel('1 Pack')).toEqual({ pack: 1, unit: 'piece' });
    expect(parsePackLabel('1 Small')).toEqual({ pack: 1, unit: 'piece' });
    expect(parsePackLabel('1 dozen')).toEqual({ pack: 12, unit: 'piece' });
  });

  // Zepto's labels (design Appendix D). Read as "1 pack" alone, milk became one
  // piece and never a number of millilitres.
  it('reads a counted pack by the contents it states', () => {
    expect(parsePackLabel('1 pack (500 ml)')).toEqual({ pack: 500, unit: 'ml' });
    expect(parsePackLabel('1 Pack (1 ltr)')).toEqual({ pack: 1, unit: 'l' });
    expect(parsePackLabel('1 piece (1 kg)')).toEqual({ pack: 1, unit: 'kg' });
  });

  // Zepto's loose produce and its "either size" packs (design Appendix D).
  it('takes the smaller of sizes the store does not fix: the least it promises', () => {
    expect(parsePackLabel('1 pack (500 g or 534 g)')).toEqual({ pack: 500, unit: 'g' });
    expect(parsePackLabel('1 pc (118 ml or 125 ml)')).toEqual({ pack: 118, unit: 'ml' });
    expect(parsePackLabel('900 g - 1 kg')).toEqual({ pack: 900, unit: 'g' });
    expect(parsePackLabel('200 - 300 g')).toEqual({ pack: 200, unit: 'g' });
    expect(parsePackLabel('1 kg or 900 g')).toEqual({ pack: 900, unit: 'g' });
  });

  it('will not choose between sizes of different kinds', () => {
    expect(parsePackLabel('500 g or 500 ml')).toBeNull();
    expect(parsePackLabel('3 pcs (750 - 900 g)')).toBeNull();
  });

  it('will not guess whether several stated packs are each or all of the contents', () => {
    expect(parsePackLabel('2 pack (500 ml)')).toBeNull();
  });

  it('returns null rather than guessing when there is no size', () => {
    expect(parsePackLabel('Assorted')).toBeNull();
    expect(parsePackLabel('')).toBeNull();
  });
});

describe("lineQty — one order line in the item's canonical unit", () => {
  it('multiplies the pack by the count and converts to the base unit', () => {
    expect(lineQty(2, '500 ml', 'ml')).toBe(1000);
    expect(lineQty(1, '1 ltr x 2', 'ml')).toBe(2000);
    expect(lineQty(3, '1 kg', 'g')).toBe(3000);
    expect(lineQty(2, '6 Pieces', 'piece')).toBe(12);
    expect(lineQty(1, '1 dozen', 'piece')).toBe(12);
    expect(lineQty(2, '1 pack (500 ml)', 'ml')).toBe(1000);
  });

  it('is null across dimensions — a bunch of coriander is not a number of grams', () => {
    expect(lineQty(1, '1 Bunch', 'g')).toBeNull();
    expect(lineQty(1, '500 g', 'ml')).toBeNull();
  });

  it('is null when the pack is unknown — a pack to learn, never a guess', () => {
    expect(lineQty(1, null, 'ml')).toBeNull();
    expect(lineQty(1, 'Assorted', 'g')).toBeNull();
  });
});
