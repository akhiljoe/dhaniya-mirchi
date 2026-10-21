// Reading Instamart's own answers for the cart (design Appendix C): which
// pack is which, whether it is in stock, what the bill says, and whether the
// store is delivering. Shapes copied from the real recon (2026-09-20).
import { describe, expect, it } from 'vitest';

import { findBySearch, findVariation, freeDeliveryAbove, pickAddress, readAddresses, readCartState, readCustomerId } from '../src/worker/adapters/instamart-catalog.js';

const variation = (over: Record<string, unknown>) => ({
  skuId: 'SKU1',
  spinId: 'SPIN1',
  displayName: 'Nandini Pasteurised Toned Milk',
  quantityDescription: '500 ml',
  price: { offerPrice: { units: '24' }, mrp: { units: '24' } },
  inventory: { inStock: true },
  imageIds: ['NI_CATALOG/IMAGES/ciw/2025/12/17/87310a53-66ae-4e51-9131-3e11591fcbfa_Q3L8WG2OTP_MN_17122025.png'],
  ...over,
});

// The search answer nests listings deep inside widgets; each listing has its
// packs under `variations`.
const searchAnswer = (listings: unknown[][]) => ({
  data: { cards: listings.map((variations) => ({ card: { card: { gridElements: { infoWithStyle: { items: [{ variations }] } } } } })) },
});

describe('finding the exact product and pack', () => {
  const single = variation({});
  const twoPack = variation({ skuId: 'SKU2', quantityDescription: '500 ml x 2', price: { offerPrice: { units: '48' } }, imageIds: ['a/b/two-pack-image-file.png'] });
  const answer = searchAnswer([[single, twoPack]]);

  it('takes the pack that was asked for, with its price and stock', () => {
    const found = findVariation(answer, 'Nandini Pasteurised Toned Milk', '500 ml');
    expect(found.variation).toBe(single);
    expect(found).toMatchObject({ price: 24, inStock: true });
  });

  it('matches the name and pack however they are spaced or capitalised', () => {
    expect(findVariation(answer, '  nandini   pasteurised toned MILK ', '500 ML').variation).toBe(single);
  });

  it('carries the whole listing’s image files, so the right card can be found', () => {
    expect(findVariation(answer, 'Nandini Pasteurised Toned Milk', '500 ml').imageKeys).toEqual([
      '87310a53-66ae-4e51-9131-3e11591fcbfa_Q3L8WG2OTP_MN_17122025.png',
      'two-pack-image-file.png',
    ]);
  });

  it('says which packs the store does list when the wanted one is missing', () => {
    const found = findVariation(answer, 'Nandini Pasteurised Toned Milk', '1 L');
    expect(found.variation).toBeNull();
    expect(found.packsSeen).toEqual(['500 ml', '500 ml x 2']);
  });

  it('reports out of stock rather than hiding it', () => {
    const out = searchAnswer([[variation({ inventory: { inStock: false } })]]);
    expect(findVariation(out, 'Nandini Pasteurised Toned Milk', '500 ml')).toMatchObject({ inStock: false });
  });

  it('keeps two listings with the same name apart by pack', () => {
    const kilo = variation({ skuId: 'CURD1', displayName: 'Milky Mist Set Curd', quantityDescription: '1 kg', price: { offerPrice: { units: '136' } }, imageIds: ['x/curd-one-kilo-image.png'] });
    const small = variation({ skuId: 'CURD2', displayName: 'Milky Mist Set Curd', quantityDescription: '200 g', price: { offerPrice: { units: '38' } }, imageIds: ['x/curd-small-image-file.png'] });
    const curd = searchAnswer([[kilo], [small]]);
    const found = findVariation(curd, 'Milky Mist Set Curd', '1 kg');
    expect(found.variation).toBe(kilo);
    expect(found.imageKeys).toEqual(['curd-one-kilo-image.png']); // the 200 g card's image is not ours
  });
});

describe('reading the cart', () => {
  const cart = (over: Record<string, unknown> = {}) => ({
    data: {
      data: {
        items: [{ itemId: 'SKU1', displayName: 'Nandini Pasteurised Toned Milk', quantity: 2 }],
        bill: { itemTotal: '48.0', toPay: '158.0', deliveryCharges: '30.0', surgeFee: '30.0', smallCartCharges: '20.0' },
        storesInfo: [{ serviceabilityDetails: { serviceabilityStatus: 2, sla: '23 Mins' } }],
        unavailableErrorMsg: '',
        ...over,
      },
    },
  });

  it('gives the lines and the vendor’s own totals', () => {
    const state = readCartState(cart());
    expect(state.lines).toEqual([{ sku: 'SKU1', name: 'Nandini Pasteurised Toned Milk', quantity: 2 }]);
    expect(state.bill).toEqual({ itemTotal: 48, toPay: 158, delivery: 30, surge: 30, smallCart: 20, other: null, freeDeliveryAbove: null });
  });

  // The store's own free-delivery line, so the app can say "₹12 more and
  // delivery is free" without ever inventing the figure. Real shape, from a
  // captured cart answer.
  // Instamart says it two ways on the same field and the wording decides
  // which: with an empty cart it states the line, with a filled one it
  // states what is left to spend. Reading one as the other would have the
  // app tell a household with ₹187 of shopping they were already past
  // a ₹12 line.
  describe('what the store says delivery is free above', () => {
    const nudge = (text: string) => ({ nudgeComms: { success: { text } } });

    it('takes the line itself when the store states it', () => {
      expect(freeDeliveryAbove(nudge('<b>FREE DELIVERY</b> on orders above ₹199'))).toBe(199);
    });

    it('reads past the markup and the comma', () => {
      expect(freeDeliveryAbove(nudge('<b>FREE  Delivery</b> above ₹ 1,299 only'))).toBe(1299);
    });

    // The shape the app shows once there is a cart.
    it('adds what is left to spend to what the cart already holds', () => {
      expect(freeDeliveryAbove(nudge('Add items worth ₹12 more for <b>FREE DELIVERY</b>'), 187)).toBe(199);
      expect(freeDeliveryAbove(nudge('You are ₹12 away from <b>FREE DELIVERY</b>'), 187)).toBe(199);
    });

    // A gap is worth nothing without the cart it is a gap from, and half an
    // answer here is a wrong threshold rather than a missing one.
    it('drops what is left to spend when the cart total is unknown', () => {
      expect(freeDeliveryAbove(nudge('Add items worth ₹12 more for FREE DELIVERY'))).toBeNull();
    });

    it('ignores a nudge about something else', () => {
      expect(freeDeliveryAbove(nudge('Unlock <b>FLAT 10% OFF</b> on orders above ₹499'), 187)).toBeNull();
    });

    it('says nothing on wording that places the figure neither way', () => {
      expect(freeDeliveryAbove(nudge('FREE DELIVERY unlocked, ₹199 saved'), 187)).toBeNull();
    });

    it('says nothing when the store says nothing', () => {
      expect(freeDeliveryAbove(undefined)).toBeNull();
      expect(freeDeliveryAbove({})).toBeNull();
      expect(freeDeliveryAbove(nudge('FREE DELIVERY on your next order'))).toBeNull();
    });

    // Through readCartState, at the path the real answer puts it
    // (data.data.comms), so the wiring is proved and not only the parsing.
    it('reaches it where the cart answer keeps it', () => {
      const withNudge = cart({ comms: { nudgeComms: { success: { text: '<b>FREE DELIVERY</b> on orders above ₹199' } } } });
      expect(readCartState(withNudge).bill.freeDeliveryAbove).toBe(199);
    });

    // itemTotal is 48 on this fixture, so the gap wording resolves against it.
    it('uses the cart s own item total for the gap', () => {
      const withGap = cart({ comms: { nudgeComms: { success: { text: 'Add items worth ₹151 more for FREE DELIVERY' } } } });
      expect(readCartState(withGap).bill.freeDeliveryAbove).toBe(199);
    });

    // It is an offer the store runs and stops running, which is the whole
    // reason it is read rather than written down.
    it('says nothing when that cart carries no nudge', () => {
      expect(readCartState(cart()).bill.freeDeliveryAbove).toBeNull();
    });
  });

  it('is serving when the store gives a delivery time', () => {
    expect(readCartState(cart())).toMatchObject({ serving: true, eta: '23 Mins', message: null });
  });

  it('is not serving when the vendor says so, and keeps its words', () => {
    const closed = cart({ storesInfo: [{ serviceabilityDetails: { serviceabilityStatus: 3, sla: '' } }], unavailableErrorMsg: 'Store is closed right now' });
    expect(readCartState(closed)).toMatchObject({ serving: false, message: 'Store is closed right now' });
  });

  it('is not serving when nothing quotes a delivery time', () => {
    expect(readCartState(cart({ storesInfo: [{ serviceabilityDetails: { serviceabilityStatus: 3, sla: '' } }] }))).toMatchObject({ serving: false, eta: null });
  });

  // Seen on the real account (2026-09-20): the shipment said 5 while the store
  // said 2, and the app was delivering in 40 minutes.
  it('is serving when the codes disagree but a delivery time is quoted', () => {
    const mixed = cart({
      storesInfo: [{ serviceabilityDetails: { serviceabilityStatus: 5 } }],
      shipmentDetails: [{ serviceabilityDetails: { serviceabilityStatus: 2, sla: '40 Mins' } }],
    });
    expect(readCartState(mixed)).toMatchObject({ serving: true, eta: '40 Mins', statuses: [5, 2] });
  });

  it('reads an empty cart without inventing anything', () => {
    expect(readCartState({ data: { data: { items: [] } } })).toMatchObject({ lines: [], bill: { toPay: null }, serving: true });
  });
});

// The shape is the app's own (recorded 2026-09-18); the values are made up.
const address = (over: Record<string, unknown> = {}, actual: Record<string, unknown> = {}) => ({
  id: 'cusmavl1d67840j8tk5g',
  display_address: 'Maple, Plot 16, Example Layout, Bengaluru, Karnataka 560001, India',
  created_at: 1785342927,
  version: 2,
  actual_address: {
    account_details: { name: 'A HOUSEHOLD', phone: '9999999999' },
    address_category: [3],
    address_line: 'Maple, Plot 16',
    city: 'Bengaluru',
    contact_name: 'A HOUSEHOLD',
    formatted_address: 'Maple, Plot 16, Example Layout, Bengaluru',
    location: { lat: 12.9716000, lng: 77.5946000 },
    phone: '9999999999',
    tags: ['Maple Residency'],
    ...actual,
  },
  ...over,
});
const addressAnswer = (list: unknown[]) => ({ data: { addresses: list, statusCode: 0 }, statusCode: 0 });

describe('the addresses saved in the app', () => {
  it('reads the household’s own label and the coordinates the store follows from', () => {
    expect(readAddresses(addressAnswer([address()]))).toEqual([
      {
        id: 'cusmavl1d67840j8tk5g',
        label: 'Maple Residency',
        display: 'Maple, Plot 16, Example Layout, Bengaluru, Karnataka 560001, India',
        lat: 12.9716000,
        lng: 77.5946000,
        name: 'A HOUSEHOLD',
      },
    ]);
  });

  it('leaves out an address with no coordinates: it could not pick a store', () => {
    expect(readAddresses(addressAnswer([address({}, { location: {} }), address({ id: 'b' })]))).toHaveLength(1);
  });

  it('copes with no label, and with an answer it does not know', () => {
    expect(readAddresses(addressAnswer([address({}, { tags: [] })]))[0].label).toBe('');
    expect(readAddresses({ data: null })).toEqual([]);
    expect(readAddresses('not json at all')).toEqual([]);
  });
});

describe('choosing which address a cart is for', () => {
  const maple = { id: 'a', label: 'Maple Residency', display: 'Maple, Example Layout', lat: 1, lng: 2, name: '' };
  const office = { id: 'b', label: 'Tech Park', display: 'Tech Park bus stop', lat: 3, lng: 4, name: '' };

  it('takes the one the household’s orders go to', () => {
    expect(pickAddress([office, maple], 'Maple Residency')).toBe(maple);
    expect(pickAddress([office, maple], '  maple residency ')).toBe(maple);
  });

  it('falls back to an address that contains the label', () => {
    expect(pickAddress([office, maple], 'Example Layout')).toBe(maple);
  });

  it('takes the only address there is when nothing is known', () => {
    expect(pickAddress([maple], null)).toBe(maple);
  });

  it('never guesses between several: a cart at the wrong store is worse', () => {
    expect(pickAddress([office, maple], null)).toBeNull();
    expect(pickAddress([office, maple], 'Somewhere else')).toBeNull();
    expect(pickAddress([], 'Maple Residency')).toBeNull();
  });
});

describe('the account’s own id at the vendor', () => {
  it('is found wherever the answer carries it', () => {
    expect(readCustomerId({ data: { orders: [{ customer_id: '5000001', order_id: 'o1' }] } })).toBe('5000001');
    expect(readCustomerId({ data: { customerId: 5000001 } })).toBe('5000001');
  });

  it('is null when the answer has none, rather than a guess', () => {
    expect(readCustomerId({ data: { orders: [] } })).toBeNull();
    expect(readCustomerId('nonsense')).toBeNull();
  });
});

describe('what the store sells for something never bought before', () => {
  const paneer200 = variation({ skuId: 'P200', displayName: 'Milky Mist Paneer', quantityDescription: '200 g', price: { offerPrice: { units: '99' } }, imageIds: ['x/paneer-small-image.png'] });
  const paneer1k = variation({ skuId: 'P1K', displayName: 'Milky Mist Paneer', quantityDescription: '1 kg', price: { offerPrice: { units: '420' } }, imageIds: ['x/paneer-big-image-file.png'] });
  const cheese = variation({ skuId: 'C1', displayName: 'Amul Cheese Slices', quantityDescription: '200 g', price: { offerPrice: { units: '130' } }, imageIds: ['x/cheese-image-file.png'] });
  const answer = searchAnswer([[cheese], [paneer200, paneer1k]]);

  it('takes the listing whose name carries every word, cheapest pack first', () => {
    const found = findBySearch(answer, 'paneer');
    expect(found.variation).toBe(paneer200);
    expect(found).toMatchObject({ price: 99, inStock: true });
    expect(found.packsSeen).toEqual(['200 g', '1 kg']);
  });

  it('skips a pack that is out of stock', () => {
    const out = searchAnswer([[variation({ ...paneer200, inventory: { inStock: false } }), paneer1k]]);
    expect(findBySearch(out, 'milky mist paneer').variation?.skuId).toBe('P1K');
  });

  it('matches on all the words, not any of them', () => {
    expect(findBySearch(answer, 'amul cheese').variation).toBe(cheese);
    expect(findBySearch(answer, 'amul paneer').variation).toBeNull();
  });

  it('adds nothing when the store has nothing like it', () => {
    expect(findBySearch(answer, 'dragon fruit').variation).toBeNull();
  });
});
