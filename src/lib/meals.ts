// "What do you want to make?" (design §19 "AI mode"). The model is the cook:
// it says what a dish needs. Everything after is code — matching each
// ingredient to the household's own items, comparing with what is at home,
// and deciding what to buy. A meal plan never changes an estimate: it is a
// suggestion, and anything bought because of it is a prompted purchase
// (§9.2), recorded when it goes into the cart.
import { classify } from '@/catalog/classify';

import { api } from './api';
import type { InventoryItem } from '../types';

export interface MealIngredient {
  name: string;
  quantity: number | null;
  unit: 'ml' | 'g' | 'piece' | null;
  essential: boolean;
}

export interface Meal {
  dish: string;
  serves: number;
  ingredients: MealIngredient[];
  note: string | null;
}

export interface MealRequest {
  status: 'requested' | 'running' | 'done' | 'failed';
  result: { meal?: Meal } | null;
  errorCode: string | null;
}

export function askForMeal(text: string, items: { id: string; unit: 'ml' | 'g' | 'piece' }[]): Promise<{ id: string }> {
  return api('POST', '/api/ai/meal', { text, items });
}

export function getMeal(id: string): Promise<MealRequest> {
  return api('GET', `/api/ai/requests/${encodeURIComponent(id)}`);
}

// One ingredient, against what the household has.
export interface MealLine {
  ingredient: MealIngredient;
  // The household's own item, when this is something it buys.
  item: InventoryItem | null;
  // What the page does with it:
  //  'have'     — at home, by the app's own estimate
  //  'check'    — bought by this household, but likely running low
  //  'new'      — never bought here: the store's own product, if they want it
  //  'pantry'   — salt, water and the like: no amount, assumed at home
  state: 'have' | 'check' | 'new' | 'pantry';
}

const PANTRY = /^(salt|water|sugar|oil|ghee|turmeric|pepper|spices?|masala)$/;

// What to buy for a dish. Pure: the model's list in, the page's list out.
export function planFor(meal: Meal, inventory: InventoryItem[]): MealLine[] {
  const byId = new Map(inventory.map((i) => [i.id, i]));
  return meal.ingredients.map((ingredient) => {
    // The catalog turns "basmati rice" into the household's own item name.
    const canonical = classify(ingredient.name, null).canonical;
    const item = byId.get(canonical) ?? byId.get(ingredient.name) ?? null;
    let state: MealLine['state'];
    if (!item) state = ingredient.quantity === null && PANTRY.test(ingredient.name) ? 'pantry' : 'new';
    else if (item.status === 'plenty') state = 'have';
    else if (item.status === 'unknown' && ingredient.quantity === null) state = 'pantry';
    else state = 'check';
    return { ingredient, item, state };
  });
}

// "500 g", "2 pieces", "some"
export function amountText(i: MealIngredient): string {
  if (i.quantity === null || i.unit === null) return 'some';
  if (i.unit === 'piece') return `${i.quantity} ${i.quantity === 1 ? 'piece' : 'pieces'}`;
  if (i.unit === 'g' && i.quantity >= 1000) return `${Math.round(i.quantity / 100) / 10} kg`;
  if (i.unit === 'ml' && i.quantity >= 1000) return `${Math.round(i.quantity / 100) / 10} L`;
  return `${i.quantity} ${i.unit}`;
}
