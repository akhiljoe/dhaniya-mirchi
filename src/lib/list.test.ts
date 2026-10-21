// Showing only the top few items of a list, most likely first, with the rest
// behind "Show N more".
import { describe, expect, it } from 'vitest';

import { mostLikelyFirst, splitTop, summarizeNames, isEverydayItem, splitEveryday } from './list';

// Measured on real history (spike/merge/backtest.ts): putting the items
// bought most often first took the top 3 from 25% right to 59%.
describe('mostLikelyFirst', () => {
  it('puts the items bought most often first', () => {
    const items = [
      { id: 'monthly', usualGapDays: 30, dueRatio: 1, daysUntilLow: 0 },
      { id: 'daily', usualGapDays: 1.2, dueRatio: 1.5, daysUntilLow: 0 },
      { id: 'weekly', usualGapDays: 7, dueRatio: 1.1, daysUntilLow: 0 },
    ];
    expect(mostLikelyFirst(items).map((i) => i.id)).toEqual(['daily', 'weekly', 'monthly']);
  });

  it('breaks ties by the least overdue, then the fewest days left', () => {
    const items = [
      { id: 'late', usualGapDays: 7, dueRatio: 1.8, daysUntilLow: 0 },
      { id: 'due', usualGapDays: 7, dueRatio: 1.0, daysUntilLow: 1 },
      { id: 'due-sooner', usualGapDays: 7, dueRatio: 1.0, daysUntilLow: 0 },
    ];
    expect(mostLikelyFirst(items).map((i) => i.id)).toEqual(['due-sooner', 'due', 'late']);
  });

  it('puts items with no usual gap last, and leaves the input alone', () => {
    const items = [
      { id: 'unknown', usualGapDays: null, dueRatio: null, daysUntilLow: null },
      { id: 'known', usualGapDays: 10, dueRatio: 1, daysUntilLow: 2 },
    ];
    expect(mostLikelyFirst(items).map((i) => i.id)).toEqual(['known', 'unknown']);
    expect(items.map((i) => i.id)).toEqual(['unknown', 'known']);
  });
});

describe('splitTop', () => {
  it('shows the first n and hides the rest', () => {
    expect(splitTop([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], hidden: [4, 5] });
  });

  it('hides nothing when there are n or fewer', () => {
    expect(splitTop([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], hidden: [] });
    expect(splitTop([], 3)).toEqual({ shown: [], hidden: [] });
  });
});

describe('summarizeNames', () => {
  it('names the first n and counts the rest', () => {
    expect(summarizeNames(['Milk', 'Bread', 'Eggs', 'Curd', 'Rice'], 3)).toBe('Milk, Bread, Eggs and 2 more');
    expect(summarizeNames(['Milk', 'Bread', 'Eggs', 'Curd'], 3)).toBe('Milk, Bread, Eggs and 1 more');
  });

  it('just lists them when there are n or fewer', () => {
    expect(summarizeNames(['Milk', 'Bread'], 3)).toBe('Milk, Bread');
    expect(summarizeNames(['Milk'], 3)).toBe('Milk');
  });
});

describe('splitEveryday', () => {
  const item = (name: string, usualGapDays: number | null) => ({ name, usualGapDays, dueRatio: 1, daysUntilLow: 1 });

  // Milk's usual gap on the real household is 1.1 days: "will you buy this in
  // the next few days" is always yes, so it sat at the top of the buy-now list
  // every morning, including the one after three packets arrived.
  it('separates what is bought most days from the alerts', () => {
    const { alerts, everyday } = splitEveryday([item('Milk', 1.1), item('Rice', 21), item('Bread', 1.4), item('Atta', 40)]);
    expect(everyday.map((i) => i.name)).toEqual(['Milk', 'Bread']);
    expect(alerts.map((i) => i.name)).toEqual(['Rice', 'Atta']);
  });

  it('keeps each group most likely first', () => {
    const { alerts } = splitEveryday([item('Atta', 40), item('Rice', 21)]);
    expect(alerts.map((i) => i.name)).toEqual(['Rice', 'Atta']);
  });

  // Nothing is dropped: the two groups together are the whole list. Hiding a
  // flag was measured and lost a fifth of the recall (engine holdback.ts).
  it('loses nothing', () => {
    const items = [item('Milk', 1.1), item('Rice', 21), item('Unknown', null)];
    const { alerts, everyday } = splitEveryday(items);
    expect(alerts.length + everyday.length).toBe(items.length);
  });

  it('treats an item with no usual gap as an alert, never an everyday staple', () => {
    expect(isEverydayItem(item('Unknown', null))).toBe(false);
    const { everyday } = splitEveryday([item('Unknown', null)]);
    expect(everyday).toEqual([]);
  });
});
