// Which of an app's saved addresses a household's cart is filled for
// (design §19 stage 1). The app keeps a cart per store and the store follows
// from the address, so picking the wrong one leaves the items in a cart
// nobody looks at.
import { describe, expect, it } from 'vitest';

import { accountHolderName, addressNote, matchAddresses, rankAddresses } from './connect';

const addr = (id: string, label: string, display: string) => ({ id, label, display });

describe('rankAddresses', () => {
  // One household connected with 65 saved addresses, so the order matters.
  it('puts the current choice first', () => {
    const list = [addr('1', 'Work', 'MG Road'), addr('2', 'Home', 'Maple Block')];
    expect(rankAddresses(list, '2').map((a) => a.id)).toEqual(['2', '1']);
  });

  // A short label is a name someone typed ("Home"); a long one is the street
  // address the app filled in by itself.
  it('then the ones the household bothered to name', () => {
    const list = [addr('1', '12 Claret Road, Example Layout, Bengaluru', 'x'), addr('2', 'Home', 'y')];
    expect(rankAddresses(list).map((a) => a.id)).toEqual(['2', '1']);
  });

  it('leaves the original list alone', () => {
    const list = [addr('1', 'Work', 'x'), addr('2', 'Home', 'y')];
    rankAddresses(list, '2');
    expect(list.map((a) => a.id)).toEqual(['1', '2']);
  });
});

describe('matchAddresses', () => {
  const list = [addr('1', 'Home', 'Maple Block, Bengaluru'), addr('2', 'Work', 'MG Road')];

  it('searches the label and the address', () => {
    expect(matchAddresses(list, 'maple').map((a) => a.id)).toEqual(['1']);
    expect(matchAddresses(list, 'work').map((a) => a.id)).toEqual(['2']);
  });

  it('gives everything back for an empty search', () => {
    expect(matchAddresses(list, '  ')).toHaveLength(2);
  });

  it('gives nothing rather than everything when nothing matches', () => {
    expect(matchAddresses(list, 'mumbai')).toEqual([]);
  });
});

describe('telling apart four addresses called Home', () => {
  // The real list this was written for: 39 saved Blinkit addresses across
  // four cities, several labelled "Home", two shared to the account from
  // somebody else's (design Appendix A). Label and street do not separate
  // them, and on Blinkit the address chooses the store.
  const own = (id: string, label: string) => ({ id, label, display: 'Somewhere', name: 'Alex Doe' });

  it('finds the account holder in the name on most of the addresses', () => {
    const list = [own('1', 'Home'), own('2', 'Work'), { id: '3', label: 'Tony', display: 'Delhi', name: 'Tony' }];
    expect(accountHolderName(list)).toBe('Alex Doe');
  });

  it('has no holder to name when the vendor gives no names', () => {
    // Instamart sends none. Nothing is then called somebody else's, which is
    // right: with nothing to compare against, every row would look foreign.
    expect(accountHolderName([{ id: '1', label: 'Home', display: 'Maple' }])).toBeNull();
    expect(addressNote({ id: '1', label: 'Home', display: 'Maple' }, null)).toBeNull();
  });

  it('calls out an address shared from another account, above everything else', () => {
    // The one that matters most: not the household's address at all.
    const shared = { id: '9', label: 'Alex Doe', display: 'Delhi', name: 'Alex Doe', source: 'SHARED_ADDRESS' };
    expect(addressNote(shared, 'Alex Doe')).toBe('Shared from another account');
  });

  it('names the person when the parcel is for somebody else', () => {
    expect(addressNote({ id: '3', label: 'Tony', display: 'Delhi', name: 'Tony' }, 'Alex Doe')).toBe('For Tony');
  });

  it('says where a Zomato address came from', () => {
    // Explains why a grocery address list holds hotels and restaurants.
    expect(addressNote({ ...own('4', 'Hotel'), source: 'ZOMATO_IMPORT' }, 'Alex Doe')).toBe('Saved from Zomato');
    expect(addressNote({ ...own('5', 'Work'), source: 'ZOMATO' }, 'Alex Doe')).toBe('Saved from Zomato');
  });

  it('says nothing about the household own addresses, so the odd ones stand out', () => {
    expect(addressNote(own('1', 'Home'), 'Alex Doe')).toBeNull();
    // A source we have not seen is not shown raw at the household.
    expect(addressNote({ ...own('6', 'Home'), source: 'SOME_NEW_THING' }, 'Alex Doe')).toBeNull();
  });

  it('searches the name too, because that is what is remembered about a Home', () => {
    const list = [own('1', 'Home'), { id: '3', label: 'Home', display: 'Delhi', name: 'Tony' }];
    expect(matchAddresses(list, 'tony').map((a) => a.id)).toEqual(['3']);
  });
});
