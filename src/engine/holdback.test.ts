// What is in the house explains the flag (design §9.6, holdback.ts).
import { describe, expect, it } from 'vitest';

import { STOCK_ENOUGH_FOR_TODAY_DAYS } from './constants';
import { stockCoversToday } from './holdback';

describe('stockCoversToday', () => {
  // The case it was written for: milk bought twice yesterday and twice today,
  // the list says buy, and the card says "About 972 ml left". Both are right;
  // the card should say why.
  it('is true when a day or more is left, on the pessimistic end', () => {
    expect(stockCoversToday({ daysRemainingLow: 2.5 })).toBe(true);
    expect(stockCoversToday({ daysRemainingLow: STOCK_ENOUGH_FOR_TODAY_DAYS })).toBe(true);
  });

  it('is false when the house is nearly out', () => {
    expect(stockCoversToday({ daysRemainingLow: 0.4 })).toBe(false);
    expect(stockCoversToday({ daysRemainingLow: 0 })).toBe(false);
  });

  // "We don't know how much is left" is not evidence that the house is
  // stocked (design §9.3: never invent a quantity).
  it('is false when the amount left is unknown', () => {
    expect(stockCoversToday({ daysRemainingLow: null })).toBe(false);
  });

  // Confidence lives in the range: less confidence widens it, the pessimistic
  // end falls, and the sentence stops being claimed (design §9.4).
  it('follows the pessimistic end, so an unsure estimate claims nothing', () => {
    expect(stockCoversToday({ daysRemainingLow: 2 })).toBe(true);
    expect(stockCoversToday({ daysRemainingLow: 0.5 })).toBe(false);
  });
});
