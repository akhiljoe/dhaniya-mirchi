// The AI layer in the browser (design §7.8): the one sum done here — a daily
// amount once the household says how big its measure is — and the wording.
import { describe, expect, it } from 'vitest';

import { perDayFrom, rupees } from './ai';

describe('perDayFrom', () => {
  it('"half a glass, twice a day, for 2 people" with a 250 ml glass is 500 ml a day', () => {
    expect(perDayFrom({ field: 'measure', measure: 'glass', unit: 'ml', quantity: 0.5, timesPerDay: 2, persons: 2 }, 250)).toBe(500);
  });

  it('rounds to hundredths, never inventing precision', () => {
    expect(perDayFrom({ field: 'measure', measure: 'cup', unit: 'ml', quantity: 1, timesPerDay: 3, persons: 1 }, 33.333)).toBe(100);
  });
});

describe('rupees', () => {
  it('says small costs plainly', () => {
    expect(rupees(0.4)).toBe('under ₹1');
    expect(rupees(12.6)).toBe('₹13');
    expect(rupees(1234.2)).toBe('₹1,234');
    expect(rupees(null)).toBe('not known');
  });
});
