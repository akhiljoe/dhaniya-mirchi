// When the household buys next (design §9.6): the running-low status read from
// the household's own rhythm of shopping trips.
import { describe, expect, it } from 'vitest';

import { DUE_HORIZON_DAYS, MS_PER_DAY, due, type Purchase } from './index';

const T0 = new Date('2026-01-01T06:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * MS_PER_DAY);
const buys = (...days: number[]): Purchase[] => days.map((d) => ({ at: at(d), qty: 1000 }));
// Every `step` days from day 0, `count` times.
const every = (step: number, count: number) => buys(...Array.from({ length: count }, (_, i) => i * step));

describe('due — the running-low status', () => {
  it('flags an item as it comes due, and not right after it was bought', () => {
    const p = every(14, 10); // fortnightly; last bought day 126
    expect(due(p, at(127)).status).toBe('AVAILABLE');
    expect(due(p, at(136)).status).toBe('BUY_SOON'); // the 14-day gap closes within 4 days
    expect(due(p, at(136)).usualGapDays).toBeCloseTo(14, 6);
    expect(due(p, at(136)).daysToNext).toBeCloseTo(4, 6);
  });

  it('says "coming up" when the next buy is likely only within the longer horizon', () => {
    const p = every(10, 8); // last bought day 70
    expect(due(p, at(73)).status).toBe('RUNNING_LOW'); // due in 7 days: inside 8, outside 4
    expect(due(p, at(73)).daysToNext).toBeCloseTo(7, 6); // and it says so: "coming up" never shows ~24 days
    expect(due(p, at(77)).status).toBe('BUY_SOON');
  });

  it('never invents a rhythm: too few gaps → UNKNOWN, no likelihood', () => {
    const e = due(buys(0, 10), at(12));
    expect(e).toMatchObject({ trips: 2, intervals: 1, likelihood: null, usualGapDays: null, status: 'UNKNOWN' });
    expect(due([], at(1))).toMatchObject({ trips: 0, daysSinceLast: null, status: 'UNKNOWN' });
  });

  it('stops flagging once an item is well past every gap it has had — flags expire', () => {
    const p = every(7, 6); // last bought day 35
    expect(due(p, at(40)).status).toBe('BUY_SOON');
    const later = due(p, at(60)); // 25 days on: over 1.5 usual gaps, longer than any gap
    expect(later).toMatchObject({ status: 'STOPPED', beyondHistory: true, likelihood: 0 });
  });

  it('calls a steady item that is a little late due, not stopped', () => {
    const p = every(7, 6); // last bought day 35; longest gap 7
    expect(due(p, at(43))).toMatchObject({ status: 'BUY_SOON', beyondHistory: true, daysToNext: 0 }); // 8 days: late
    expect(due(p, at(46)).status).toBe('STOPPED'); // 11 days: past 1.5 × 7
  });

  it('keeps prompted purchases out of the rhythm, but still counts them as bought', () => {
    // Weekly on its own. Then we suggested it every 2 days, three times.
    const own = every(7, 8); // … day 49
    const prompted: Purchase[] = [51, 53, 55].map((d) => ({ at: at(d), qty: 1000, prompted: true }));
    const e = due([...own, ...prompted], at(57));
    expect(e.usualGapDays).toBeCloseTo(7, 6); // not 2: our own suggestions never confirm themselves
    expect(e.droppedForPrompted).toBe(3);
    expect(e.daysSinceLast).toBeCloseTo(2, 6); // the prompted buy on day 55 was still a buy
  });

  it('treats orders hours apart as one shopping trip', () => {
    const p = [...every(6, 6), { at: new Date(at(30).getTime() + 3 * 3_600_000), qty: 500 }];
    const e = due(p, at(31));
    expect(e.trips).toBe(6);
    expect(e.usualGapDays).toBeCloseTo(6, 6);
  });

  it('drops gaps that overlap a coverage gap — purchases may hide inside them', () => {
    const p = buys(0, 60, 67, 74, 81);
    const e = due(p, at(83), { gaps: [{ from: null, to: at(30), reason: 'coverage' }] });
    expect(e.droppedForGaps).toBe(1);
    expect(e.usualGapDays).toBeCloseTo(7, 6);
  });

  it('takes away days out of gaps and out of the time since the last buy', () => {
    // Every 5 days; a 10-day trip inside one gap and one after the last buy.
    const p = buys(0, 5, 10, 25, 30);
    const away = [
      { from: at(12), to: at(22) },
      { from: at(31), to: at(41) },
    ];
    const e = due(p, at(43), { away });
    expect(e.shortenedForAway).toBe(1);
    expect(e.usualGapDays).toBeCloseTo(5, 6);
    expect(e.daysSinceLast).toBeCloseTo(3, 6); // 13 days, 10 of them away
    expect(e.status).toBe('BUY_SOON');
  });

  it('weighs recent habits over old ones', () => {
    // Every 20 days for a year, then every 3 days for the last month.
    const old = every(20, 18); // … day 340
    const recent = buys(343, 346, 349, 352, 355, 358, 361, 364, 367, 370);
    const e = due([...old, ...recent], at(372));
    expect(e.usualGapDays).toBeCloseTo(3, 6);
    expect(e.status).toBe('BUY_SOON');
  });

  it("uses the horizon it is given, within the item's own rhythm", () => {
    const p = every(10, 8); // last bought day 70; due day 80
    expect(due(p, at(78), {}, 1).likelihood).toBe(0); // one day out: not yet
    expect(due(p, at(78), {}, DUE_HORIZON_DAYS).likelihood).toBeGreaterThan(0);
  });

  // A flat horizon swallows a fast item whole: bread bought every 2 days is
  // "likely bought within 4 days" the hour it arrives, so the list said buy
  // bread on the day the bread came. The horizon given is a cap, and an item
  // that comes round faster is judged on half its own gap instead.
  it("never looks further ahead than half the item's usual gap", () => {
    const p = every(2, 20); // every 2 days; last bought day 38
    const justBought = due(p, at(38.1), {}, DUE_HORIZON_DAYS);
    expect(justBought.status).not.toBe('BUY_SOON');
    expect(justBought.daysToNext).toBeGreaterThan(0.5); // and says when instead
    expect(due(p, at(39.5), {}, DUE_HORIZON_DAYS).status).toBe('BUY_SOON'); // a day later it is due
  });

  // The floor: the list is read once a day, so a horizon under a day would be
  // a flag that appears and vanishes between two looks.
  it('never shrinks the horizon below a day, however fast the item', () => {
    const p = every(0.5, 30); // twice a day; last bought day 14.5
    expect(due(p, at(15.2), {}, DUE_HORIZON_DAYS).status).toBe('BUY_SOON');
  });

  // The household that bought potatoes two hours ago has potatoes. The rhythm
  // alone cannot see that: a household that sometimes rebuys the next day has
  // short gaps in its history, and the quantile the flag is read from sits at
  // a day or two even the hour the shopping arrives. Those short gaps are the
  // times they ran out; today they did not.
  it('never says buy an item that was just bought, and says when instead', () => {
    // Bought every 6 days on average, but sometimes the next day.
    const p = buys(0, 6, 7, 13, 19, 20, 26, 32, 33, 39);
    expect(due(p, at(39.1)).status).toBe('RUNNING_LOW');
    expect(due(p, at(39.1)).daysToNext).toBeGreaterThan(0);
  });

  it('flags it once the quiet window has passed', () => {
    const p = buys(0, 6, 7, 13, 19, 20, 26, 32, 33, 39);
    expect(due(p, at(42.5)).status).toBe('BUY_SOON'); // out of the window, and due
  });

  // Half a gap, capped at a day: a fortnightly item bought two days ago is
  // judged on its rhythm like any other, not held quiet for a week.
  it('holds an item quiet for at most a day, however slow it is', () => {
    const p = every(14, 10); // fortnightly; last bought day 126
    expect(due(p, at(136)).status).toBe('BUY_SOON'); // 10 days on: due, not quiet
  });

  // What the household told us beats what we inferred: they said how much a
  // day goes, and this trip bought less than a day of it.
  it("still says buy when the household's own daily amount says it is out", () => {
    const p = [...every(6, 8).slice(0, -1), { at: at(42), qty: 200 }]; // last trip: 200 ml
    const regular = [{ from: at(0), to: null, perDay: 500 }];
    expect(due(p, at(42.1), {}, DUE_HORIZON_DAYS, { regular }).status).toBe('BUY_SOON');
  });
});
