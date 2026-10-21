// Which app each thing comes from (vendorSplit.ts). The household sent a
// list and found items missing from the cart; this is the part that could
// have said so first, from their own orders.
import { describe, expect, it } from 'vitest';

import type { Product } from './products';
import { splitByVendor, splitNote, type SplitLine } from './vendorSplit';

const line = (item: string, vendors: string[]): SplitLine => ({
  item,
  name: item[0].toUpperCase() + item.slice(1),
  product: { name: `${item} product`, pack: '1 pack', vendors, recent: 3, total: 9, usualCount: 1, lastAt: '2026-09-20T00:00:00Z' } as Product,
});
const appName = (v: string) => (v === 'blinkit' ? 'Blinkit' : 'Swiggy Instamart');

describe('which app a thing comes from', () => {
  it('keeps what they buy on this app, and groups the rest by where they do buy it', () => {
    const s = splitByVendor(
      [line('milk', ['instamart']), line('coriander', ['blinkit']), line('bread', ['instamart', 'blinkit']), line('rusk', ['blinkit'])],
      'instamart',
    );
    expect(s.here.map((l) => l.item)).toEqual(['milk', 'bread']);
    expect(s.elsewhere).toHaveLength(1);
    expect(s.elsewhere[0]).toMatchObject({ vendor: 'blinkit' });
    expect(s.elsewhere[0].lines.map((l) => l.item)).toEqual(['coriander', 'rusk']);
  });

  it('treats no record at all as no evidence, so it still goes in the cart', () => {
    // Nothing imported yet, or a product the tally has never seen. An empty
    // record is not evidence of absence.
    const s = splitByVendor([line('salt', [])], 'instamart');
    expect(s.here.map((l) => l.item)).toEqual(['salt']);
    expect(s.elsewhere).toEqual([]);
  });

  it('says nothing when everything is bought on this app', () => {
    const s = splitByVendor([line('milk', ['instamart']), line('bread', ['instamart'])], 'instamart');
    expect(s.elsewhere).toEqual([]);
    expect(splitNote(s, appName)).toBeNull();
  });

  it('counts them and names where, in the household s own words', () => {
    const s = splitByVendor([line('milk', ['instamart']), line('coriander', ['blinkit']), line('rusk', ['blinkit'])], 'instamart');
    expect(splitNote(s, appName)).toBe('2 of these you only buy on Blinkit.');
  });

  it('puts the app with the most of them first', () => {
    const s = splitByVendor([line('a', ['blinkit']), line('b', ['zepto']), line('c', ['blinkit'])], 'instamart');
    expect(s.elsewhere.map((g) => g.vendor)).toEqual(['blinkit', 'zepto']);
  });
});
