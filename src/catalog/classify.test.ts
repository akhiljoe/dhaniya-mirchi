// Product names → canonical household items (design §8). The rules came from
// two years of real Blinkit + Instamart orders; each case below is one the
// spike got wrong at some point, so a rule edit that breaks it shows here.
import { describe, expect, it } from 'vitest';

import { classify, classifyLine, displayName, isStock } from './classify';

const canon = (name: string, pack: string | null = null) => classify(name, pack).canonical;

describe('classify', () => {
  it('groups brands and pack sizes into one household item', () => {
    expect(classify('Amul Taaza Toned Fresh Milk', '500 ml')).toMatchObject({ canonical: 'milk', category: 'dairy', unit: 'ml' });
    expect(canon('Nandini Shubham Pasteurised Standardised Milk')).toBe('milk');
    expect(canon('Akshayakalpa Organic Curd')).toBe('curd');
    expect(canon('Farm Fresh Brown Eggs - 6 pcs')).toBe('eggs');
  });

  it('puts drinks and ice cream first — their names carry ingredient words', () => {
    expect(canon('Pepsi Zero Sugar Soft Drink Can')).toBe('soft drink');
    expect(canon('Pineapple Juice')).toBe('juice');
    expect(canon('Belgian Dark Chocolate Ice Cream Tub')).toBe('ice cream');
    expect(canon('Jeera Masala Soda')).toBe('soft drink');
  });

  it('keeps full-cream milk as milk, and cream as cream', () => {
    expect(canon('Amul Gold Full Cream Milk')).toBe('milk');
    expect(canon('Amul Fresh Cream')).toBe('cream');
  });

  it('keeps prepared foods out of raw meat', () => {
    expect(canon('Chicken Masala Cubes')).toBe('seasoning cubes');
    expect(canon('Pedigree Chicken Dog Food')).toBe('dog food');
    expect(canon('Licious Chicken Curry Cut')).toBe('chicken');
  });

  it('matches whole words where a substring would mislead', () => {
    expect(canon('Smoothing Shampoo')).toBe('shampoo'); // not "hing"
    expect(canon('Aashirvaad Atta 0% Maida')).toBe('atta');
    expect(canon('Coconut Milk')).toBe('coconut milk');
  });

  // Found on the household's real orders (2026-09-19): each of these had been
  // read as a different item, which gave it a wrong rhythm.
  it('keeps look-alike names apart', () => {
    expect(canon('Parle Elaichi Rusk Pouch')).toBe('rusk'); // not cardamom
    expect(canon('Jk Masale Cardamom Small')).toBe('cardamom');
    expect(canon('Spring Onion (Hasiru Eerulli)')).toBe('spring onion'); // not onion
    expect(canon('Onion (Eerulli)')).toBe('onion');
    expect(canon('Lijjat Moong Papad (Pouch)')).toBe('papad'); // not dal
    expect(canon('Tata Sampann Unpolished Toor/Arhar Dal')).toBe('dal');
    expect(canon('Langra Mango (Malda) (Mavina Hannu)')).toBe('mango');
    expect(canon('Everest Dry Mango Powder (Spice Amchur)')).toBe('spices & masala');
    expect(canon('Maaza Mango Drink')).toBe('juice');
    expect(canon('Cofsils Orange Strip Of 10 Lozenges')).toBe('medicines'); // not orange
    expect(canon('Finish Dishwasher Tablets')).toBe('dishwash & scrub'); // not medicines
    expect(canon('Goofy Tails Lamb Bone Broth For Dogs-100Ml')).toBe('dog food'); // not mutton
    expect(canon('NOICE Golden Sweet Bun (Freshly made)')).toBe('buns & pav');
    expect(canon('NOICE Mallige Idli Batter (Stoneground)')).toBe('idli dosa batter');
    // Dog treats that read as milk, eggs or sausage (seen in "Your products", 2026-09-20).
    expect(canon('Drools Absolute Milk Bone Jar 300 Gm Adult & Puppy Dog Treats')).toBe('dog treats');
    expect(canon('Drools Chicken and Egg Biscuit')).toBe('dog treats');
    expect(canon('Drools Real Chicken Sausage for Dog 10Pcs Jar')).toBe('dog treats');
    expect(canon('Drools Dog 100% Real Chicken Sausage 5+1 Free')).toBe('dog treats');
    expect(canon('Nandini Pasteurised Toned Milk')).toBe('milk');
  });

  it('marks non-groceries so they never become inventory', () => {
    expect(classify('Kalyan Jewellers 10 gm Silver Voucher', null).category).toBe('exclude');
    expect(classify('Google Pay Gift Card', null).category).toBe('exclude');
    expect(classify('Photo Print Portrait', null).category).toBe('exclude');
  });

  it('falls back to the leading words of the name, with the unit from the pack label', () => {
    expect(classify('Himalayan Pink Rock Crystals 500 g', '500 g')).toMatchObject({ canonical: 'himalayan pink rock crystals', category: 'other', unit: 'g' });
    expect(classify('Some New Juice Thing', '1 L').unit).toBe('ml');
    expect(classify('Mystery Gadget', null).unit).toBe('piece');
  });

  it('gives every item an emoji', () => {
    expect(classify('Amul Taaza Toned Fresh Milk', null).emoji).toBe('🥛');
    expect(classify('Himalayan Pink Rock Crystals', null).emoji).not.toBe('');
  });
});

describe('displayName', () => {
  it('capitalises the canonical name for display', () => {
    expect(displayName('milk')).toBe('Milk');
    expect(displayName('chips & namkeen')).toBe('Chips & namkeen');
  });
});

describe('classify caching', () => {
  it('returns the same answer for the same name and pack, from cache', () => {
    const a = classify('Amul Taaza Toned Fresh Milk', '500 ml');
    expect(classify('Amul Taaza Toned Fresh Milk', '500 ml')).toBe(a); // same object: cached
    expect(classify('Amul Taaza Toned Fresh Milk', null)).toEqual(a); // same rule, separate entry
  });
});

describe('a snack made of a vegetable is not the vegetable', () => {
  // The cart added "BALAJI Cream & Onion Potato Wafers" when the list said
  // potatoes (2026-09-21): the produce rule was read first and \bpotato\b
  // matched the crisps.
  it('reads potato crisps as a snack', () => {
    expect(classify('BALAJI Cream & Onion Potato Wafers', '140 g').canonical).toBe('chips & namkeen');
    expect(classify('Lays Classic Salted Potato Chips', '52 g').canonical).toBe('chips & namkeen');
    expect(classify('Potato Chips Masala', null).canonical).toBe('chips & namkeen');
    expect(classify('Banana Chips', '200 g').canonical).toBe('chips & namkeen');
  });

  it('still reads a potato as a potato', () => {
    expect(classify('Potato (Aloo Gadde)', '1 kg').canonical).toBe('potato');
    expect(classify('Baby Potato', '500 g').canonical).toBe('potato');
    expect(classify('Sweet Potato (Sihi Genasu)', '500 g').canonical).toBe('sweet potato');
  });
});

// Zepto Cafe's food sits in the same orders as the groceries (design
// Appendix D). Read by name, 30 chicken puffs were 30 buys of chicken.
describe('food made to eat now', () => {
  it('is café food when the vendor marks it, whatever its name says', () => {
    const c = classifyLine({ name: 'Chicken Puff', packLabel: '100 g', prepared: true });
    expect(c).toMatchObject({ canonical: 'café food', category: 'prepared' });
    expect(classifyLine({ name: 'Paneer Makhani + Wheat Chapati (3 pcs)', packLabel: '2 combo', prepared: true }).canonical).toBe('café food');
  });

  it('is never guessed from a name: an unmarked line is classified as before', () => {
    expect(classifyLine({ name: 'Chicken Puff', packLabel: '100 g' }).canonical).toBe('chicken');
    expect(classifyLine({ name: 'Chicken Puff', packLabel: '100 g', prepared: null })).toEqual(classify('Chicken Puff', '100 g'));
  });

  it('is spending, not stock', () => {
    expect(isStock(classifyLine({ name: 'Chicken Puff', packLabel: null, prepared: true }))).toBe(false);
    expect(isStock(classify('Nandini Toned Milk', '500 ml'))).toBe(true);
    expect(isStock(classify('Gift Card', null))).toBe(false);
  });
});

describe("Zepto's promotional inserts", () => {
  it.each(['A Postcard For Your Home', "Father's Day Newspaper: Dad Chronicles", 'Snabbit June 3 Bangalore Campaign', 'Sattva City a project by Sattva group', 'Dabur Hajmola Coasters', 'No More Swalpa Adjust Madi', 'TATA Croma Flyer', 'BIG Sale (Flyer)'])(
    '"%s" is not groceries',
    (name) => {
      expect(classify(name, '1 piece').category).toBe('exclude');
    },
  );
});
