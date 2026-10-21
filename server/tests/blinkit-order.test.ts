// Which address a Blinkit cart is filled against (blinkit-order.ts).
//
// On this vendor the address chooses the STORE, so getting it wrong is not a
// parcel at the wrong door: it is a cart filled from a shop in another city,
// with a different catalogue, that can never deliver it. This household's 39
// saved addresses span four cities, hold several entries labelled "Home", and
// include two shared to this account from another account.
import { describe, expect, it } from 'vitest';

import { chooseAddress } from '../src/worker/blinkit-order.js';
import type { VendorAddress } from '../src/worker/adapters/instamart-catalog.js';

const bengaluru: VendorAddress = { id: '100000001', label: 'Home', display: 'Bengaluru', lat: 12.971600, lng: 77.594600, name: 'A Household' };
const delhi: VendorAddress = { id: '900001', label: 'Old flat', display: 'New Delhi', lat: 28.6, lng: 77.2, name: 'A Household' };

describe('choosing the address to fill against', () => {
  it('uses the one the household chose', () => {
    expect(chooseAddress(bengaluru, [bengaluru, delhi])).toEqual({ address: bengaluru });
  });

  it('lets the operator name one, and that beats the stored choice', () => {
    expect(chooseAddress(bengaluru, [bengaluru, delhi], '900001')).toEqual({ address: delhi });
  });

  it('refuses rather than guessing when nothing has been chosen', () => {
    // The dangerous case: several saved addresses and no answer. Picking the
    // first would fill a cart in Delhi for a household in Bengaluru.
    expect(chooseAddress(null, [delhi, bengaluru])).toEqual({ address: null, reason: 'must_choose' });
  });

  it('refuses a named address it does not have', () => {
    expect(chooseAddress(bengaluru, [bengaluru], '900001')).toEqual({ address: null, reason: 'not_found' });
  });

  it('says so when the account has saved none', () => {
    expect(chooseAddress(null, [])).toEqual({ address: null, reason: 'none_saved' });
  });
});
