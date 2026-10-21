// Which of a household's products is sent to which app.
//
// Their products carry the apps they were bought on. Ignoring that sent
// Instamart's names to Blinkit - "Amul Pasteurised Butter", "Epigamia Greek
// Yogurt - Blueberry" and three more - and every line came back not listed,
// so the cart was empty and there was nothing to pay for.
import { describe, expect, it } from 'vitest';

import { boughtOn, choiceForVendor, type Product } from './products';

const p = (name: string, vendors: string[], over: Partial<Product> = {}): Product => ({
  name,
  pack: '500 g',
  vendors,
  recent: 1,
  total: 5,
  usualCount: 1,
  lastAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('choosing a product for the app the cart is going to', () => {
  const butter = [p('Amul Pasteurised Butter', ['instamart']), p('Amul Butter', ['blinkit'])];

  it('sends each app the name the household buys there', () => {
    expect(choiceForVendor(butter, 'blinkit')?.name).toBe('Amul Butter');
    expect(choiceForVendor(butter, 'instamart')?.name).toBe('Amul Pasteurised Butter');
  });

  it('keeps the usual product when no app is named', () => {
    expect(choiceForVendor(butter, null)?.name).toBe('Amul Pasteurised Butter');
  });

  it('falls back rather than sending nothing at all', () => {
    // Never bought on Blinkit. It is still worth asking for - the worker
    // says "not listed" if the store does not have it, and says so to the
    // household rather than substituting something.
    const onlyThere = [p('Epigamia Greek Yogurt - Blueberry', ['instamart'])];
    expect(choiceForVendor(onlyThere, 'blinkit')?.name).toBe('Epigamia Greek Yogurt - Blueberry');
  });

  it('prefers a product with no app recorded over one from the other app', () => {
    // Nothing says where an unrecorded one came from, so it is the better
    // guess than a name known to belong to the other app.
    const mixed = [p('Nandini Curd', ['instamart']), p('Curd 500 g', [])];
    expect(choiceForVendor(mixed, 'blinkit')?.name).toBe('Curd 500 g');
  });

  it('has nothing to choose from an empty list', () => {
    expect(choiceForVendor([], 'blinkit')).toBeNull();
  });
});

describe('whether they buy it there at all', () => {
  it('knows when they do and when they do not', () => {
    const only = [p('Epigamia Greek Yogurt - Blueberry', ['instamart'])];
    expect(boughtOn(only, 'instamart')).toBe(true);
    expect(boughtOn(only, 'blinkit')).toBe(false);
  });

  it('says yes when no app is named, and when nothing was recorded', () => {
    expect(boughtOn([p('Amul Butter', ['instamart'])], null)).toBe(true);
    expect(boughtOn([p('Amul Butter', [])], 'blinkit')).toBe(true);
  });
});
