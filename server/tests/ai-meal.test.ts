// What a dish needs (design §19 "AI mode"): the model is the cook, so what
// it answers is read strictly and bounded. Anything outside the shape is
// refused whole — a half-read recipe would propose the wrong shopping.
import { describe, expect, it } from 'vitest';

import { MEAL_MAX_INGREDIENTS, readMeal, UnreadableMeal, type MealAnswer } from '../src/ai/meal-schema.js';

const biryani = {
  dish: 'chicken biryani',
  serves: 4,
  ingredients: [
    { name: 'chicken', quantity: 1000, unit: 'g', essential: true },
    { name: 'basmati rice', quantity: 750, unit: 'g', essential: true },
    { name: 'curd', quantity: 250, unit: 'g', essential: true },
    { name: 'onion', quantity: 3, unit: 'piece', essential: true },
    { name: 'salt', quantity: null, unit: null, essential: true },
    { name: 'mint', quantity: 20, unit: 'g', essential: false },
  ],
  note: 'Hyderabadi style.',
};

describe('reading what a dish needs', () => {
  it('reads a whole answer', () => {
    const meal: MealAnswer = readMeal(biryani);
    expect(meal.dish).toBe('chicken biryani');
    expect(meal.serves).toBe(4);
    expect(meal.ingredients).toHaveLength(6);
    expect(meal.ingredients[0]).toEqual({ name: 'chicken', quantity: 1000, unit: 'g', essential: true });
    expect(meal.ingredients[4]).toEqual({ name: 'salt', quantity: null, unit: null, essential: true }); // "some"
    expect(meal.ingredients[5].essential).toBe(false);
  });

  it('tidies names and keeps them plain', () => {
    const meal = readMeal({ ...biryani, ingredients: [{ name: '  Basmati   Rice ', quantity: 500, unit: 'g', essential: true }] });
    expect(meal.ingredients[0].name).toBe('basmati rice');
  });

  it('treats an amount with no unit as "some"', () => {
    const meal = readMeal({ ...biryani, ingredients: [{ name: 'chicken', quantity: 2, unit: null, essential: true }] });
    expect(meal.ingredients[0].quantity).toBeNull();
  });

  it('refuses an amount no dish could need', () => {
    expect(() => readMeal({ ...biryani, ingredients: [{ name: 'chilli', quantity: 12_000, unit: 'g', essential: true }] })).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, ingredients: [{ name: 'egg', quantity: 500, unit: 'piece', essential: true }] })).toThrow(UnreadableMeal);
  });

  it('refuses a list that is not a recipe', () => {
    expect(() => readMeal({ ...biryani, ingredients: [] })).toThrow(UnreadableMeal);
    expect(() =>
      readMeal({ ...biryani, ingredients: Array.from({ length: MEAL_MAX_INGREDIENTS + 1 }, (_, i) => ({ name: `thing ${i}`, quantity: 1, unit: 'g', essential: true })) }),
    ).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, ingredients: [biryani.ingredients[0], biryani.ingredients[0]] })).toThrow(UnreadableMeal); // twice
  });

  it('refuses anything outside the shape, rather than half-reading it', () => {
    expect(() => readMeal({ ...biryani, serves: 0 })).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, serves: 200 })).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, dish: '' })).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, extra: true })).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, ingredients: [{ name: 'rice', quantity: 500, unit: 'cups', essential: true }] })).toThrow(UnreadableMeal);
    expect(() => readMeal('a lovely biryani')).toThrow(UnreadableMeal);
  });

  it('refuses a name that is not a name (it is shown on the page)', () => {
    expect(() => readMeal({ ...biryani, ingredients: [{ name: '<script>x</script>', quantity: 1, unit: 'g', essential: true }] })).toThrow(UnreadableMeal);
    expect(() => readMeal({ ...biryani, ingredients: [{ name: 'rice\nand more', quantity: 1, unit: 'g', essential: true }] })).toThrow(UnreadableMeal);
  });

  it('keeps the note short, or drops it', () => {
    expect(readMeal({ ...biryani, note: null }).note).toBeNull();
    expect(readMeal({ ...biryani, note: '   ' }).note).toBeNull();
    expect(readMeal({ ...biryani, note: 'x'.repeat(400) }).note).toHaveLength(200);
  });
});
