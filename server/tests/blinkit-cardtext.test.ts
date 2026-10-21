// Reading a product card, which is one run-together string.
//
// A card reads "English Oven Sandwich White Bread400 g₹60ADD" - the name, the
// pack, the price and the button, with no spaces between them. Stored whole,
// that is what the household is shown their cart contains and what goes into
// prompted_adds as the thing they bought.
import { describe, expect, it } from 'vitest';

import { cleanProductName, packFrom, totalFromCartPage, cardLabelsFrom, cartCountFrom } from '../src/worker/adapters/blinkit-page.js';

describe('the product name on a card', () => {
  it('stops at the pack, the price and the button', () => {
    expect(cleanProductName('English Oven Sandwich White Bread400 g₹60ADD')).toBe('English Oven Sandwich White Bread');
    expect(cleanProductName('Amul Fresh Butter Cookies200 g₹85ADD')).toBe('Amul Fresh Butter Cookies');
  });

  it('drops the vendor s own furniture at the front', () => {
    expect(cleanProductName('12 MINS Amul Taaza Toned Milk 500 ml ₹29 ADD')).toBe('Amul Taaza Toned Milk');
    expect(cleanProductName('SPONSORED Modern Bread400 g₹50ADD')).toBe('Modern Bread');
  });

  it('does not leave a connector dangling where it cut', () => {
    expect(cleanProductName('Amul Taaza Toned Milk - Pack of 22 x 200 ml₹34ADD')).toBe('Amul Taaza Toned Milk');
  });

  it('leaves a clean name alone', () => {
    expect(cleanProductName('Nandini Shubham Toned Milk')).toBe('Nandini Shubham Toned Milk');
  });

  it('has nothing to say about a fragment that is only a pack or a price', () => {
    // The cart page hands over its pieces separately, and these were being
    // read as the names of the things in the cart: a milk-and-curd cart
    // listed itself as "Amul Taaza Toned Milk", "500 ml", "₹29U15".
    expect(cleanProductName('500 ml')).toBe('');
    expect(cleanProductName('₹29U15')).toBe('');
    expect(cleanProductName('400 g')).toBe('');
  });
});

describe('the pack on a card', () => {
  it('reads what is actually being offered', () => {
    expect(packFrom('English Oven Sandwich White Bread400 g₹60ADD')).toBe('400 g');
    expect(packFrom('12 MINS Amul Taaza Toned Milk 500 ml ₹29 ADD')).toBe('500 ml');
    // Ambiguous on purpose, and left that way: the card says "Pack of 2" and
    // then "2 x 200 ml", which run together as "Pack of 22 x 200 ml". No
    // reading of that string can tell the two 2s apart, so the pack is only
    // ever shown, never counted on - the quantity comes from the household.
    expect(packFrom('Amul Taaza Toned Milk - Pack of 22 x 200 ml₹34ADD')).toContain('200 ml');
  });

  it('says nothing rather than inventing one', () => {
    expect(packFrom('Nandini Shubham Toned Milk')).toBe('');
  });
});

describe('the cart page s own numbers', () => {
  it('reads the total whether or not the words are spaced', () => {
    // The bar runs them together, and did not always.
    expect(totalFromCartPage('₹122TOTALProceed')).toBe(122);
    expect(totalFromCartPage('₹849 TOTAL Proceed To Pay')).toBe(849);
    expect(totalFromCartPage('₹1,240TOTALProceed')).toBe(1240);
  });

  it('says nothing rather than zero when there is no total', () => {
    expect(totalFromCartPage('My Cart You don t have any items in your cart')).toBeNull();
    expect(totalFromCartPage('')).toBeNull();
  });

  it('counts what the page says is in the cart', () => {
    expect(cartCountFrom('3 items ₹129')).toBe(3);
    expect(cartCountFrom('1 item ₹29')).toBe(1);
    expect(cartCountFrom('0 items ₹ 0')).toBe(0);
    expect(cartCountFrom('nothing here')).toBe(0);
  });

  it('names the cards the sheet offers, by the digits that tell them apart', () => {
    expect(cardLabelsFrom(['Amex American Express Card****** 1111Enter CVVCVV'])).toEqual(['Amex American Express Card ******1111']);
    expect(cardLabelsFrom(['no digits here'])).toEqual([]);
  });
});
