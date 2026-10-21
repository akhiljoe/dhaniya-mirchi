// What to buy for a dish (design §19 "AI mode"): the model says what the
// dish needs, code says what the household must buy.
import { describe, expect, it } from 'vitest';

import { amountText, planFor, type Meal } from './meals';
import type { InventoryItem } from '../types';

const item = (id: string, status: InventoryItem['status']): InventoryItem => ({
  id,
  name: id,
  emoji: '🍚',
  category: 'Staples',
  estimatedAmount: '',
  daysUntilLow: null,
  confidence: 'medium',
  lastPurchased: 'yesterday',
  purchaseFrequency: 'Every ~7 days',
  typicalQuantity: '1 kg',
  history: [],
  status,
});

const meal = (ingredients: Meal['ingredients']): Meal => ({ dish: 'chicken biryani', serves: 4, ingredients, note: null });
const ing = (name: string, quantity: number | null = 500, unit: 'g' | 'ml' | 'piece' | null = 'g', essential = true) => ({ name, quantity, unit, essential });

describe('what to buy for a dish', () => {
  it('says what is at home and what to check', () => {
    const inventory = [item('rice', 'plenty'), item('curd', 'likely-low')];
    const lines = planFor(meal([ing('basmati rice', 750), ing('curd', 250)]), inventory);
    expect(lines.map((l) => l.state)).toEqual(['have', 'check']);
    expect(lines[0].item?.id).toBe('rice'); // the catalog knows basmati rice is rice
  });

  it('marks something the household has never bought as new', () => {
    const lines = planFor(meal([ing('star anise', 5)]), [item('rice', 'plenty')]);
    expect(lines[0]).toMatchObject({ state: 'new', item: null });
  });

  it('does not send anyone shopping for salt', () => {
    const lines = planFor(meal([ing('salt', null, null)]), []);
    expect(lines[0].state).toBe('pantry');
  });

  it('keeps an item whose amount is unknown out of the way when no amount is asked', () => {
    const lines = planFor(meal([ing('oil', null, null)]), [item('oil', 'unknown')]);
    expect(lines[0].state).toBe('pantry');
  });
});

describe('the amount, as a person would say it', () => {
  it('reads plainly', () => {
    expect(amountText(ing('rice', 750))).toBe('750 g');
    expect(amountText(ing('rice', 1500))).toBe('1.5 kg');
    expect(amountText(ing('milk', 1000, 'ml'))).toBe('1 L');
    expect(amountText(ing('onion', 3, 'piece'))).toBe('3 pieces');
    expect(amountText(ing('onion', 1, 'piece'))).toBe('1 piece');
    expect(amountText(ing('salt', null, null))).toBe('some');
  });
});
