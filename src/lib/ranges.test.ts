// The date range a page is read over (design §12.7).
import { describe, expect, it } from 'vitest';

import { rangeText, withinRange } from './ranges';

const NOW = new Date('2026-09-20T12:00:00Z');
const ago = (days: number) => ({ at: new Date(NOW.getTime() - days * 86_400_000).toISOString() });

describe('withinRange', () => {
  it('keeps what falls inside the window, newest included', () => {
    const rows = [ago(0), ago(29), ago(31)];
    expect(withinRange(rows, 30, NOW)).toEqual([ago(0), ago(29)]);
  });

  it('keeps everything when the range is all time', () => {
    const rows = [ago(0), ago(900)];
    expect(withinRange(rows, null, NOW)).toEqual(rows);
  });

  it('three months holds a staple bought every six weeks, which 30 days hides', () => {
    const atta = [ago(3), ago(45)];
    expect(withinRange(atta, 30, NOW)).toHaveLength(1);
    expect(withinRange(atta, 90, NOW)).toHaveLength(2);
  });

  it('gives an empty list rather than failing when nothing is inside', () => {
    expect(withinRange([ago(400)], 30, NOW)).toEqual([]);
  });
});

describe('rangeText', () => {
  it('reads as part of a sentence', () => {
    expect(rangeText(30)).toBe('the last 30 days');
    expect(rangeText(90)).toBe('the last 3 months');
    expect(rangeText(365)).toBe('the last 12 months');
    expect(rangeText(null)).toBe('all time');
  });
});
