// Turning the api's import rows into what the page says (design §7.10).
import { describe, expect, it } from 'vitest';

import { doneText, overallImport, progressText, timeLeftText, vendorChips, type ImportJob } from './imports';

const NOW = new Date('2026-09-19T10:00:00Z');
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();

function job(fields: Partial<ImportJob>): ImportJob {
  return {
    kind: 'first',
    vendor: 'instamart',
    status: 'listing',
    ordersDone: 0,
    skusTotal: null,
    skusDone: 0,
    readyAt: null,
    completedAt: null,
    errorCode: null,
    startedAt: at(-5),
    estimate: { readyAt: null, completeAt: null, stillCounting: true },
    ...fields,
  };
}

describe('overallImport', () => {
  it('is "none" with nothing imported', () => {
    expect(overallImport([]).phase).toBe('none');
  });

  it('has no percent while the order list is still being read, and its estimate is a lower bound', () => {
    const o = overallImport([job({ status: 'listing', ordersDone: 80, estimate: { readyAt: at(3), completeAt: at(9), stillCounting: true } })]);
    expect(o).toMatchObject({ phase: 'running', percent: null, ordersDone: 80, stillCounting: true, sync: false });
    expect(o.completeAt?.toISOString()).toBe(at(9));
  });

  it('counts pack lookups across vendors for the percent, and waits for the slowest', () => {
    const o = overallImport([
      job({ vendor: 'instamart', status: 'packs', skusTotal: 300, skusDone: 150, estimate: { readyAt: at(1), completeAt: at(5), stillCounting: false } }),
      job({ vendor: 'blinkit', status: 'packs', skusTotal: 100, skusDone: 50, estimate: { readyAt: at(1), completeAt: at(12), stillCounting: false } }),
    ]);
    expect(o).toMatchObject({ percent: 50, stillCounting: false });
    expect(o.completeAt?.toISOString()).toBe(at(12));
  });

  it('is "ready" once every running import has its most-bought items done', () => {
    expect(overallImport([job({ status: 'packs', skusTotal: 10, skusDone: 5, readyAt: at(-1) })]).phase).toBe('ready');
    expect(
      overallImport([job({ status: 'packs', skusTotal: 10, skusDone: 5, readyAt: at(-1) }), job({ vendor: 'blinkit', status: 'listing' })]).phase,
    ).toBe('running');
  });

  it('is "complete" when every import has finished', () => {
    const o = overallImport([job({ status: 'complete', ordersDone: 256, estimate: null, completedAt: at(-1) })]);
    expect(o).toMatchObject({ phase: 'complete', ordersDone: 256, sync: false });
  });

  it('knows a run that only fetched new orders', () => {
    expect(overallImport([job({ kind: 'sync', status: 'complete', estimate: null })]).sync).toBe(true);
    expect(overallImport([job({ kind: 'sync', status: 'complete' }), job({ kind: 'first', status: 'listing' })]).sync).toBe(false);
  });

  it('asks for attention when an import stopped, naming the vendors', () => {
    const o = overallImport([
      job({ vendor: 'instamart', status: 'needs_reconnect', estimate: null }),
      job({ vendor: 'blinkit', status: 'failed', estimate: null }),
    ]);
    expect(o).toMatchObject({ phase: 'attention', needsReconnect: ['instamart'], failed: ['blinkit'] });
  });

  it('keeps showing progress while another vendor still runs, but still names the stopped one', () => {
    const o = overallImport([job({ vendor: 'instamart', status: 'failed', estimate: null }), job({ vendor: 'blinkit', status: 'listing' })]);
    expect(o).toMatchObject({ phase: 'running', failed: ['instamart'] });
  });
});

describe('timeLeftText', () => {
  it('says it is working out the time before any order is read, never a canned range', () => {
    expect(timeLeftText(null, NOW)).toBe('working out how long this takes');
  });

  it('says "at least" while orders are still being read', () => {
    expect(timeLeftText(new Date(at(12)), NOW, true)).toBe('at least 12 min left');
    expect(timeLeftText(new Date(at(0.2)), NOW, true)).toBe('reading orders');
  });

  it('rounds up to whole minutes', () => {
    expect(timeLeftText(new Date(at(17.2)), NOW)).toBe('about 18 min left');
    expect(timeLeftText(new Date(at(1)), NOW)).toBe('about 1 min left');
  });

  it('says hours past the hour', () => {
    expect(timeLeftText(new Date(at(75)), NOW)).toBe('about 1 h 15 min left');
    expect(timeLeftText(new Date(at(120)), NOW)).toBe('about 2 h left');
  });

  it('never counts below a minute, or backwards', () => {
    expect(timeLeftText(new Date(at(0.2)), NOW)).toBe('less than a minute left');
    expect(timeLeftText(new Date(at(-3)), NOW)).toBe('less than a minute left');
  });
});

describe('doneText', () => {
  it('never says "0 orders": a sync with nothing new is up to date', () => {
    expect(doneText({ sync: true, ordersDone: 0 })).toBe('Up to date. No new orders.');
    expect(doneText({ sync: true, ordersDone: 1 })).toBe('Synced. 1 new order.');
    expect(doneText({ sync: true, ordersDone: 3 })).toBe('Synced. 3 new orders.');
  });

  it('counts what a first import read', () => {
    expect(doneText({ sync: false, ordersDone: 120 })).toBe('Import done. 120 orders read.');
  });
});

describe('vendorChips', () => {
  // A shared household has a job per connection and keeps finished runs, so
  // one chip per job showed the same app three times over (seen 2026-09-20).
  it('gives one chip an app, however many jobs it has', () => {
    const chips = vendorChips([
      job({ vendor: 'instamart', status: 'complete' }),
      job({ vendor: 'instamart', status: 'complete' }),
      job({ vendor: 'instamart', kind: 'sync', status: 'complete' }),
      job({ vendor: 'blinkit', status: 'listing' }),
    ]);
    expect(chips).toEqual([
      { vendor: 'instamart', status: 'complete', accounts: 3 },
      { vendor: 'blinkit', status: 'live', accounts: 1 },
    ]);
  });

  it('a working account beats a finished one', () => {
    const chips = vendorChips([job({ vendor: 'instamart', status: 'complete' }), job({ vendor: 'instamart', status: 'packs' })]);
    expect(chips).toEqual([{ vendor: 'instamart', status: 'live', accounts: 2 }]);
  });

  // A finished run must never hide an account that still needs the user.
  it('a stopped account beats a finished one', () => {
    const chips = vendorChips([job({ vendor: 'instamart', status: 'complete' }), job({ vendor: 'instamart', status: 'needs_reconnect' })]);
    expect(chips).toEqual([{ vendor: 'instamart', status: 'attention', accounts: 2 }]);
  });

  it('is empty when nothing is importing', () => {
    expect(vendorChips([])).toEqual([]);
  });
});

describe('progressText', () => {
  it('shows the percentage once the whole job is known', () => {
    expect(progressText({ percent: 42, ordersDone: 100 })).toBe('42%');
  });

  // Blinkit never says how many orders there are, and reading the list is the
  // work, so a count that rises beats a countdown that keeps not arriving.
  it('counts orders while the total is unknown', () => {
    expect(progressText({ percent: null, ordersDone: 230 })).toBe('230 orders so far');
    expect(progressText({ percent: null, ordersDone: 1 })).toBe('1 order so far');
  });

  it('says nothing rather than "0 orders" before anything is read', () => {
    expect(progressText({ percent: null, ordersDone: 0 })).toBeNull();
  });
});
