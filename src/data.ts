import type {
  Source,
  InventoryItem,
  ShoppingListItem,
  PurchaseHistoryEntry,
  MealIngredient,
  Meal,
} from './types';

export const SOURCES: Source[] = [
  {
    id: 'instamart',
    name: 'Swiggy Instamart',
    description: 'Quick grocery deliveries',
    icon: '🛍️',
    color: '#fc8019',
    connected: false,
  },
  {
    id: 'blinkit',
    name: 'Blinkit',
    description: 'Instant grocery & essentials',
    icon: '⚡',
    color: '#f8cb46',
    connected: false,
  },
  {
    id: 'zepto',
    name: 'Zepto',
    description: '10-minute grocery delivery',
    icon: '🚀',
    color: '#8b5cf6',
    connected: false,
  },
  {
    id: 'email',
    name: 'Email Order History',
    description: 'Scan past order emails',
    icon: '📧',
    color: '#3b82f6',
    connected: false,
  },
];

export const SAMPLE_INVENTORY: InventoryItem[] = [
  {
    id: 'milk',
    name: 'Milk',
    emoji: '🥛',
    category: 'Dairy',
    estimatedAmount: '~700ml',
    daysUntilLow: 1,
    confidence: 'high',
    lastPurchased: '4 days ago',
    purchaseFrequency: 'Every 4-5 days',
    typicalQuantity: '2L',
    status: 'likely-low',
    userCorrected: null,
    history: [
      { id: 'p1', date: 'Sep 13', source: 'instamart', quantity: '2L', price: 120 },
      { id: 'p2', date: 'Sep 9', source: 'blinkit', quantity: '2L', price: 118 },
      { id: 'p3', date: 'Sep 5', source: 'instamart', quantity: '2L', price: 120 },
      { id: 'p4', date: 'Sep 1', source: 'instamart', quantity: '2L', price: 122 },
      { id: 'p5', date: 'Aug 27', source: 'blinkit', quantity: '2L', price: 120 },
    ],
  },
  {
    id: 'bread',
    name: 'Bread',
    emoji: '🍞',
    category: 'Bakery',
    estimatedAmount: 'A few slices',
    daysUntilLow: 2,
    confidence: 'high',
    lastPurchased: '3 days ago',
    purchaseFrequency: 'Every 4 days',
    typicalQuantity: '1 loaf',
    status: 'likely-low',
    userCorrected: null,
    history: [
      { id: 'p6', date: 'Sep 14', source: 'instamart', quantity: '1 loaf', price: 45 },
      { id: 'p7', date: 'Sep 10', source: 'blinkit', quantity: '1 loaf', price: 45 },
      { id: 'p8', date: 'Sep 6', source: 'instamart', quantity: '1 loaf', price: 48 },
      { id: 'p9', date: 'Sep 2', source: 'zepto', quantity: '1 loaf', price: 45 },
    ],
  },
  {
    id: 'eggs',
    name: 'Eggs',
    emoji: '🥚',
    category: 'Dairy',
    estimatedAmount: '~4 left',
    daysUntilLow: 3,
    confidence: 'high',
    lastPurchased: '5 days ago',
    purchaseFrequency: 'Every 7 days',
    typicalQuantity: '12 pack',
    status: 'coming-up',
    userCorrected: null,
    history: [
      { id: 'p10', date: 'Sep 12', source: 'blinkit', quantity: '12 pack', price: 90 },
      { id: 'p11', date: 'Sep 5', source: 'instamart', quantity: '12 pack', price: 88 },
      { id: 'p12', date: 'Aug 29', source: 'blinkit', quantity: '12 pack', price: 90 },
      { id: 'p13', date: 'Aug 22', source: 'zepto', quantity: '12 pack', price: 92 },
    ],
  },
  {
    id: 'bananas',
    name: 'Bananas',
    emoji: '🍌',
    category: 'Fruits',
    estimatedAmount: '2-3 left',
    daysUntilLow: 4,
    confidence: 'medium',
    lastPurchased: '4 days ago',
    purchaseFrequency: 'Every 5-6 days',
    typicalQuantity: '6-7',
    status: 'coming-up',
    userCorrected: null,
    history: [
      { id: 'p14', date: 'Sep 13', source: 'instamart', quantity: '6', price: 60 },
      { id: 'p15', date: 'Sep 8', source: 'instamart', quantity: '7', price: 70 },
      { id: 'p16', date: 'Sep 2', source: 'blinkit', quantity: '6', price: 60 },
    ],
  },
  {
    id: 'rice',
    name: 'Rice',
    emoji: '🍚',
    category: 'Pantry',
    estimatedAmount: 'Plenty',
    daysUntilLow: 18,
    confidence: 'high',
    lastPurchased: '8 days ago',
    purchaseFrequency: 'Every 25 days',
    typicalQuantity: '5kg bag',
    status: 'plenty',
    userCorrected: null,
    history: [
      { id: 'p17', date: 'Sep 9', source: 'blinkit', quantity: '5kg', price: 280 },
      { id: 'p18', date: 'Aug 15', source: 'zepto', quantity: '5kg', price: 275 },
      { id: 'p19', date: 'Jul 21', source: 'blinkit', quantity: '5kg', price: 280 },
    ],
  },
  {
    id: 'detergent',
    name: 'Detergent',
    emoji: '🧴',
    category: 'Household',
    estimatedAmount: 'About half',
    daysUntilLow: 12,
    confidence: 'medium',
    lastPurchased: '15 days ago',
    purchaseFrequency: 'Every 35 days',
    typicalQuantity: '1 bottle',
    status: 'plenty',
    userCorrected: null,
    history: [
      { id: 'p20', date: 'Sep 2', source: 'blinkit', quantity: '1 bottle', price: 185 },
      { id: 'p21', date: 'Jul 28', source: 'instamart', quantity: '1 bottle', price: 190 },
    ],
  },
  {
    id: 'olive-oil',
    name: 'Olive Oil',
    emoji: '🫒',
    category: 'Pantry',
    estimatedAmount: 'Some left',
    daysUntilLow: 10,
    confidence: 'low',
    lastPurchased: '20 days ago',
    purchaseFrequency: 'Every ~40 days',
    typicalQuantity: '500ml',
    status: 'unknown',
    userCorrected: null,
    history: [
      { id: 'p22', date: 'Aug 28', source: 'blinkit', quantity: '500ml', price: 450 },
      { id: 'p23', date: 'Jul 19', source: 'zepto', quantity: '500ml', price: 445 },
    ],
  },
  {
    id: 'onions',
    name: 'Onions',
    emoji: '🧅',
    category: 'Vegetables',
    estimatedAmount: '~1kg',
    daysUntilLow: 5,
    confidence: 'medium',
    lastPurchased: '6 days ago',
    purchaseFrequency: 'Every 7-8 days',
    typicalQuantity: '1.5-2kg',
    status: 'coming-up',
    userCorrected: null,
    history: [
      { id: 'p24', date: 'Sep 11', source: 'instamart', quantity: '2kg', price: 80 },
      { id: 'p25', date: 'Sep 4', source: 'blinkit', quantity: '1.5kg', price: 60 },
      { id: 'p26', date: 'Aug 28', source: 'instamart', quantity: '2kg', price: 80 },
    ],
  },
  {
    id: 'tomatoes',
    name: 'Tomatoes',
    emoji: '🍅',
    category: 'Vegetables',
    estimatedAmount: '3-4 left',
    daysUntilLow: 2,
    confidence: 'medium',
    lastPurchased: '5 days ago',
    purchaseFrequency: 'Every 5 days',
    typicalQuantity: '500g',
    status: 'likely-low',
    userCorrected: null,
    history: [
      { id: 'p27', date: 'Sep 12', source: 'instamart', quantity: '500g', price: 40 },
      { id: 'p28', date: 'Sep 7', source: 'zepto', quantity: '500g', price: 42 },
      { id: 'p29', date: 'Sep 2', source: 'blinkit', quantity: '500g', price: 40 },
    ],
  },
  {
    id: 'toothpaste',
    name: 'Toothpaste',
    emoji: '🪥',
    category: 'Household',
    estimatedAmount: 'Plenty',
    daysUntilLow: 25,
    confidence: 'high',
    lastPurchased: '10 days ago',
    purchaseFrequency: 'Every ~45 days',
    typicalQuantity: '1 tube',
    status: 'plenty',
    userCorrected: null,
    history: [
      { id: 'p30', date: 'Sep 7', source: 'blinkit', quantity: '1 tube', price: 95 },
      { id: 'p31', date: 'Jul 24', source: 'instamart', quantity: '1 tube', price: 99 },
    ],
  },
];

export const SAMPLE_SHOPPING_LIST: ShoppingListItem[] = [
  {
    id: 's-milk',
    name: 'Milk',
    emoji: '🥛',
    reason: 'You usually buy 2L every 4-5 days. Last bought 4 days ago.',
    urgency: 'soon',
    confidence: 'high',
    status: 'pending',
  },
  {
    id: 's-bread',
    name: 'Bread',
    emoji: '🍞',
    reason: 'You usually buy a loaf every 4 days. Last bought 3 days ago.',
    urgency: 'soon',
    confidence: 'high',
    status: 'pending',
  },
  {
    id: 's-tomatoes',
    name: 'Tomatoes',
    emoji: '🍅',
    reason: 'You buy 500g every 5 days. Last bought 5 days ago.',
    urgency: 'soon',
    confidence: 'medium',
    status: 'pending',
  },
  {
    id: 's-eggs',
    name: 'Eggs',
    emoji: '🥚',
    reason: 'You buy a 12-pack every 7 days. Last bought 5 days ago.',
    urgency: 'coming-up',
    confidence: 'high',
    status: 'pending',
  },
  {
    id: 's-bananas',
    name: 'Bananas',
    emoji: '🍌',
    reason: 'You buy 6-7 every 5-6 days. Last bought 4 days ago.',
    urgency: 'coming-up',
    confidence: 'medium',
    status: 'pending',
  },
  {
    id: 's-onions',
    name: 'Onions',
    emoji: '🧅',
    reason: 'You buy 1.5-2kg every 7-8 days. Last bought 6 days ago.',
    urgency: 'coming-up',
    confidence: 'medium',
    status: 'pending',
  },
];

export const SAMPLE_PURCHASE_HISTORY: PurchaseHistoryEntry[] = [
  {
    id: 'h1',
    date: 'Today',
    at: new Date(Date.now() - 0 * 86_400_000).toISOString(),
    items: [
      { item: 'milk', product: 'Milk', pack: '2L', count: 1, name: 'Milk', emoji: '🥛', quantity: '2L', price: 120 },
      { item: 'eggs', product: 'Eggs', pack: '12 pack', count: 1, name: 'Eggs', emoji: '🥚', quantity: '12 pack', price: 90 },
    ],
    source: 'instamart',
    total: 210,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h2',
    date: 'Sep 14',
    at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    items: [
      { item: 'bread', product: 'Bread', pack: '1 loaf', count: 1, name: 'Bread', emoji: '🍞', quantity: '1 loaf', price: 45 },
      { item: 'bananas', product: 'Bananas', pack: '6', count: 1, name: 'Bananas', emoji: '🍌', quantity: '6', price: 60 },
    ],
    source: 'instamart',
    total: 105,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h3',
    date: 'Sep 13',
    at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    items: [
      { item: 'milk', product: 'Milk', pack: '2L', count: 1, name: 'Milk', emoji: '🥛', quantity: '2L', price: 120 },
      { item: 'tomatoes', product: 'Tomatoes', pack: '500g', count: 1, name: 'Tomatoes', emoji: '🍅', quantity: '500g', price: 40 },
      { item: 'onions', product: 'Onions', pack: '2kg', count: 1, name: 'Onions', emoji: '🧅', quantity: '2kg', price: 80 },
    ],
    source: 'instamart',
    total: 240,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h4',
    date: 'Sep 12',
    at: new Date(Date.now() - 11 * 86_400_000).toISOString(),
    items: [
      { item: 'eggs', product: 'Eggs', pack: '12 pack', count: 1, name: 'Eggs', emoji: '🥚', quantity: '12 pack', price: 90 },
      { item: 'bread', product: 'Bread', pack: '1 loaf', count: 1, name: 'Bread', emoji: '🍞', quantity: '1 loaf', price: 45 },
    ],
    source: 'blinkit',
    total: 135,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h5',
    date: 'Sep 11',
    at: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    items: [
      { item: 'onions', product: 'Onions', pack: '2kg', count: 1, name: 'Onions', emoji: '🧅', quantity: '2kg', price: 80 },
      { item: 'rice', product: 'Rice', pack: '5kg', count: 1, name: 'Rice', emoji: '🍚', quantity: '5kg', price: 280 },
    ],
    source: 'instamart',
    total: 360,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h6',
    date: 'Sep 10',
    at: new Date(Date.now() - 17 * 86_400_000).toISOString(),
    items: [
      { item: 'bread', product: 'Bread', pack: '1 loaf', count: 1, name: 'Bread', emoji: '🍞', quantity: '1 loaf', price: 45 },
      { item: 'milk', product: 'Milk', pack: '2L', count: 1, name: 'Milk', emoji: '🥛', quantity: '2L', price: 118 },
    ],
    source: 'blinkit',
    total: 163,
    location: 'Indiranagar, Bangalore',
  },
  {
    id: 'h7',
    date: 'Sep 9',
    at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    items: [
      { item: 'milk', product: 'Milk', pack: '2L', count: 1, name: 'Milk', emoji: '🥛', quantity: '2L', price: 120 },
      { item: 'detergent', product: 'Detergent', pack: '1 bottle', count: 1, name: 'Detergent', emoji: '🧴', quantity: '1 bottle', price: 185 },
    ],
    source: 'blinkit',
    total: 305,
    location: 'Indiranagar, Bangalore',
  },
  {
    id: 'h8',
    date: 'Sep 7',
    at: new Date(Date.now() - 23 * 86_400_000).toISOString(),
    items: [
      { item: 'toothpaste', product: 'Toothpaste', pack: '1 tube', count: 1, name: 'Toothpaste', emoji: '🪥', quantity: '1 tube', price: 95 },
      { item: 'tomatoes', product: 'Tomatoes', pack: '500g', count: 1, name: 'Tomatoes', emoji: '🍅', quantity: '500g', price: 42 },
    ],
    source: 'zepto',
    total: 137,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h9',
    date: 'Sep 5',
    at: new Date(Date.now() - 26 * 86_400_000).toISOString(),
    items: [
      { item: 'milk', product: 'Milk', pack: '2L', count: 1, name: 'Milk', emoji: '🥛', quantity: '2L', price: 120 },
      { item: 'eggs', product: 'Eggs', pack: '12 pack', count: 1, name: 'Eggs', emoji: '🥚', quantity: '12 pack', price: 88 },
      { item: 'bananas', product: 'Bananas', pack: '7', count: 1, name: 'Bananas', emoji: '🍌', quantity: '7', price: 70 },
    ],
    source: 'instamart',
    total: 278,
    location: 'Koramangala, Bangalore',
  },
  {
    id: 'h10',
    date: 'Sep 4',
    at: new Date(Date.now() - 29 * 86_400_000).toISOString(),
    items: [
      { item: 'onions', product: 'Onions', pack: '1.5kg', count: 1, name: 'Onions', emoji: '🧅', quantity: '1.5kg', price: 60 },
      { item: 'bread', product: 'Bread', pack: '1 loaf', count: 1, name: 'Bread', emoji: '🍞', quantity: '1 loaf', price: 45 },
    ],
    source: 'blinkit',
    total: 105,
    location: 'Indiranagar, Bangalore',
  },
  {
    id: 'h11',
    date: 'Sep 2',
    at: new Date(Date.now() - 32 * 86_400_000).toISOString(),
    items: [
      { item: 'bread', product: 'Bread', pack: '1 loaf', count: 1, name: 'Bread', emoji: '🍞', quantity: '1 loaf', price: 45 },
      { item: 'tomatoes', product: 'Tomatoes', pack: '500g', count: 1, name: 'Tomatoes', emoji: '🍅', quantity: '500g', price: 40 },
      { item: 'bananas', product: 'Bananas', pack: '6', count: 1, name: 'Bananas', emoji: '🍌', quantity: '6', price: 60 },
      { item: 'detergent', product: 'Detergent', pack: '1 bottle', count: 1, name: 'Detergent', emoji: '🧴', quantity: '1 bottle', price: 185 },
    ],
    source: 'blinkit',
    total: 330,
    location: 'Indiranagar, Bangalore',
  },
  {
    id: 'h12',
    date: 'Sep 1',
    at: new Date(Date.now() - 35 * 86_400_000).toISOString(),
    items: [
      { item: 'milk', product: 'Milk', pack: '2L', count: 1, name: 'Milk', emoji: '🥛', quantity: '2L', price: 122 },
    ],
    source: 'instamart',
    total: 122,
    location: 'Koramangala, Bangalore',
  },
];

export const IMPORT_STAGES = [
  { label: 'Finding your orders', detail: 'Scanning connected sources' },
  { label: 'Understanding what you bought', detail: 'Reading item names & quantities' },
  { label: 'Grouping similar products', detail: 'Matching "milk" across stores' },
  { label: 'Learning your shopping patterns', detail: 'Finding recurring purchases' },
  { label: 'Building your household inventory', detail: 'Estimating what you have now' },
];

export const LEARNED_FACTS = [
  { emoji: '🥛', text: 'You buy milk every 4-5 days' },
  { emoji: '🥚', text: 'Eggs are a weekly purchase' },
  { emoji: '🍞', text: 'Bread runs out in about 4 days' },
  { emoji: '🍚', text: 'Rice lasts you roughly 25 days' },
  { emoji: '🧴', text: 'Detergent every ~35 days' },
  { emoji: '🛒', text: 'You shop for groceries about twice a week' },
];

// --- Meal planning ---

export interface MealTemplate {
  id: string;
  name: string;
  emoji: string;
  keywords: string[];
  ingredients: MealIngredient[];
}

export const MEAL_TEMPLATES: MealTemplate[] = [
  {
    id: 'chicken-biryani',
    name: 'Chicken Biryani',
    emoji: '🍛',
    keywords: ['biryani', 'chicken biryani', 'rice', 'indian', 'dinner'],
    ingredients: [
      { name: 'Rice', emoji: '🍚', quantity: '500g', category: 'Pantry' },
      { name: 'Chicken', emoji: '🍗', quantity: '500g', category: 'Meat' },
      { name: 'Onions', emoji: '🧅', quantity: '2', category: 'Vegetables' },
      { name: 'Yogurt', emoji: '🥛', quantity: '200g', category: 'Dairy' },
      { name: 'Mint', emoji: '🌿', quantity: '1 bunch', category: 'Herbs' },
      { name: 'Coriander', emoji: '🌿', quantity: '1 bunch', category: 'Herbs' },
      { name: 'Green chilli', emoji: '🌶️', quantity: '4', category: 'Vegetables' },
      { name: 'Ginger-garlic paste', emoji: '🧄', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Biryani masala', emoji: '🧂', quantity: '1 pack', category: 'Spices' },
      { name: 'Oil', emoji: '🫒', quantity: '3 tbsp', category: 'Pantry' },
      { name: 'Salt', emoji: '🧂', quantity: 'to taste', category: 'Pantry' },
    ],
  },
  {
    id: 'pasta',
    name: 'Pasta',
    emoji: '🍝',
    keywords: ['pasta', 'italian', 'quick', 'easy', 'dinner', 'lunch'],
    ingredients: [
      { name: 'Pasta', emoji: '🍝', quantity: '500g', category: 'Pantry' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '4', category: 'Vegetables' },
      { name: 'Garlic', emoji: '🧄', quantity: '6 cloves', category: 'Vegetables' },
      { name: 'Olive oil', emoji: '🫒', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Basil', emoji: '🌿', quantity: '1 bunch', category: 'Herbs' },
      { name: 'Cheese', emoji: '🧀', quantity: '100g', category: 'Dairy' },
      { name: 'Salt', emoji: '🧂', quantity: 'to taste', category: 'Pantry' },
    ],
  },
  {
    id: 'pancakes',
    name: 'Pancakes',
    emoji: '🥞',
    keywords: ['pancakes', 'breakfast', 'sweet', 'morning'],
    ingredients: [
      { name: 'Flour', emoji: '🌾', quantity: '200g', category: 'Pantry' },
      { name: 'Milk', emoji: '🥛', quantity: '300ml', category: 'Dairy' },
      { name: 'Eggs', emoji: '🥚', quantity: '2', category: 'Dairy' },
      { name: 'Sugar', emoji: '🧂', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Butter', emoji: '🧈', quantity: '50g', category: 'Dairy' },
      { name: 'Baking powder', emoji: '🧪', quantity: '1 tsp', category: 'Pantry' },
    ],
  },
  {
    id: 'chicken-curry',
    name: 'Chicken Curry',
    emoji: '🍲',
    keywords: ['chicken curry', 'curry', 'indian', 'dinner', 'spicy'],
    ingredients: [
      { name: 'Chicken', emoji: '🍗', quantity: '500g', category: 'Meat' },
      { name: 'Onions', emoji: '🧅', quantity: '2', category: 'Vegetables' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '3', category: 'Vegetables' },
      { name: 'Ginger-garlic paste', emoji: '🧄', quantity: '1 tbsp', category: 'Pantry' },
      { name: 'Curry masala', emoji: '🧂', quantity: '2 tbsp', category: 'Spices' },
      { name: 'Cream', emoji: '🥛', quantity: '100ml', category: 'Dairy' },
      { name: 'Oil', emoji: '🫒', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Salt', emoji: '🧂', quantity: 'to taste', category: 'Pantry' },
    ],
  },
  {
    id: 'fried-rice',
    name: 'Fried Rice',
    emoji: '🍚',
    keywords: ['fried rice', 'rice', 'chinese', 'quick', 'easy', 'dinner'],
    ingredients: [
      { name: 'Rice', emoji: '🍚', quantity: '300g', category: 'Pantry' },
      { name: 'Eggs', emoji: '🥚', quantity: '3', category: 'Dairy' },
      { name: 'Onions', emoji: '🧅', quantity: '1', category: 'Vegetables' },
      { name: 'Capsicum', emoji: '🫑', quantity: '1', category: 'Vegetables' },
      { name: 'Soy sauce', emoji: '🥢', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Garlic', emoji: '🧄', quantity: '4 cloves', category: 'Vegetables' },
      { name: 'Oil', emoji: '🫒', quantity: '2 tbsp', category: 'Pantry' },
    ],
  },
  {
    id: 'tacos',
    name: 'Tacos',
    emoji: '🌮',
    keywords: ['tacos', 'mexican', 'snacks', 'party', 'friends', 'weekend'],
    ingredients: [
      { name: 'Taco shells', emoji: '🌮', quantity: '12', category: 'Pantry' },
      { name: 'Chicken', emoji: '🍗', quantity: '400g', category: 'Meat' },
      { name: 'Onions', emoji: '🧅', quantity: '1', category: 'Vegetables' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '3', category: 'Vegetables' },
      { name: 'Lettuce', emoji: '🥬', quantity: '1 head', category: 'Vegetables' },
      { name: 'Cheese', emoji: '🧀', quantity: '150g', category: 'Dairy' },
      { name: 'Sour cream', emoji: '🥛', quantity: '1 pack', category: 'Dairy' },
      { name: 'Salsa', emoji: '🥫', quantity: '1 jar', category: 'Pantry' },
      { name: 'Lime', emoji: '🍋', quantity: '2', category: 'Fruits' },
    ],
  },
  {
    id: 'south-indian-thali',
    name: 'South Indian Thali',
    emoji: '🍌',
    keywords: ['south indian', 'dosa', 'idli', 'sambar', 'indian', 'lunch', 'dinner'],
    ingredients: [
      { name: 'Rice', emoji: '🍚', quantity: '400g', category: 'Pantry' },
      { name: 'Toor dal', emoji: '🫘', quantity: '150g', category: 'Pantry' },
      { name: 'Mustard seeds', emoji: '🟡', quantity: '1 tsp', category: 'Spices' },
      { name: 'Curry leaves', emoji: '🌿', quantity: '2 sprigs', category: 'Herbs' },
      { name: 'Coconut', emoji: '🥥', quantity: '1', category: 'Pantry' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '2', category: 'Vegetables' },
      { name: 'Onions', emoji: '🧅', quantity: '1', category: 'Vegetables' },
      { name: 'Oil', emoji: '🫒', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Salt', emoji: '🧂', quantity: 'to taste', category: 'Pantry' },
    ],
  },
  {
    id: 'healthy-bowl',
    name: 'Healthy Grain Bowl',
    emoji: '🥗',
    keywords: ['healthy', 'high protein', 'bowl', 'salad', 'dinner', 'lunch', 'fit'],
    ingredients: [
      { name: 'Quinoa', emoji: '🌾', quantity: '200g', category: 'Pantry' },
      { name: 'Chicken', emoji: '🍗', quantity: '300g', category: 'Meat' },
      { name: 'Avocado', emoji: '🥑', quantity: '1', category: 'Fruits' },
      { name: 'Spinach', emoji: '🥬', quantity: '200g', category: 'Vegetables' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '2', category: 'Vegetables' },
      { name: 'Olive oil', emoji: '🫒', quantity: '2 tbsp', category: 'Pantry' },
      { name: 'Lemon', emoji: '🍋', quantity: '1', category: 'Fruits' },
    ],
  },
  {
    id: 'sandwich',
    name: 'Sandwich',
    emoji: '🥪',
    keywords: ['sandwich', 'quick', 'lunch', 'snack', 'easy'],
    ingredients: [
      { name: 'Bread', emoji: '🍞', quantity: '4 slices', category: 'Bakery' },
      { name: 'Cheese', emoji: '🧀', quantity: '4 slices', category: 'Dairy' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '1', category: 'Vegetables' },
      { name: 'Lettuce', emoji: '🥬', quantity: '2 leaves', category: 'Vegetables' },
      { name: 'Butter', emoji: '🧈', quantity: '1 tbsp', category: 'Dairy' },
    ],
  },
  {
    id: 'omelette',
    name: 'Omelette',
    emoji: '🍳',
    keywords: ['omelette', 'eggs', 'breakfast', 'quick', 'high protein'],
    ingredients: [
      { name: 'Eggs', emoji: '🥚', quantity: '3', category: 'Dairy' },
      { name: 'Onions', emoji: '🧅', quantity: '1', category: 'Vegetables' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '1', category: 'Vegetables' },
      { name: 'Cheese', emoji: '🧀', quantity: '50g', category: 'Dairy' },
      { name: 'Butter', emoji: '🧈', quantity: '1 tsp', category: 'Dairy' },
      { name: 'Salt', emoji: '🧂', quantity: 'to taste', category: 'Pantry' },
    ],
  },
  {
    id: 'snacks-platter',
    name: 'Snacks Platter',
    emoji: '🍿',
    keywords: ['snacks', 'party', 'friends', 'weekend', 'chips', 'nibbles'],
    ingredients: [
      { name: 'Chips', emoji: '🥔', quantity: '2 packs', category: 'Snacks' },
      { name: 'Dip', emoji: '🥫', quantity: '1 jar', category: 'Pantry' },
      { name: 'Cheese', emoji: '🧀', quantity: '200g', category: 'Dairy' },
      { name: 'Crackers', emoji: '🍘', quantity: '1 box', category: 'Snacks' },
      { name: 'Olives', emoji: '🫒', quantity: '1 jar', category: 'Pantry' },
      { name: 'Nuts', emoji: '🥜', quantity: '200g', category: 'Snacks' },
    ],
  },
  {
    id: 'dal-rice',
    name: 'Dal Rice',
    emoji: '🍚',
    keywords: ['dal', 'vegetarian', 'indian', 'lunch', 'dinner', 'simple'],
    ingredients: [
      { name: 'Rice', emoji: '🍚', quantity: '300g', category: 'Pantry' },
      { name: 'Toor dal', emoji: '🫘', quantity: '150g', category: 'Pantry' },
      { name: 'Onions', emoji: '🧅', quantity: '1', category: 'Vegetables' },
      { name: 'Tomatoes', emoji: '🍅', quantity: '1', category: 'Vegetables' },
      { name: 'Turmeric', emoji: '🟡', quantity: '1 tsp', category: 'Spices' },
      { name: 'Oil', emoji: '🫒', quantity: '1 tbsp', category: 'Pantry' },
      { name: 'Salt', emoji: '🧂', quantity: 'to taste', category: 'Pantry' },
    ],
  },
];

export const MEAL_SUGGESTIONS = [
  'Chicken biryani for 4 tonight',
  'Pasta tomorrow and fried rice the next day',
  'Something healthy for dinner tonight',
  'Pancakes for breakfast tomorrow',
  'Tacos and snacks for 4 friends this weekend',
  'South Indian food for the next two days',
  'Three easy dinners for this week',
  'Something high protein for dinner tonight',
];

// Inventory name → ingredient name aliases for matching
const INVENTORY_ALIASES: Record<string, string[]> = {
  milk: ['milk', 'yogurt', 'cream', 'butter'],
  rice: ['rice'],
  onions: ['onions', 'onion'],
  tomatoes: ['tomatoes', 'tomato'],
  eggs: ['eggs', 'egg'],
  bread: ['bread'],
  bananas: ['bananas', 'banana'],
  'olive-oil': ['olive oil', 'oil'],
  detergent: ['detergent'],
  toothpaste: ['toothpaste'],
};

export function matchIngredientToInventory(
  ingredientName: string,
  inventory: InventoryItem[]
): { matched: boolean; itemId?: string } {
  const lower = ingredientName.toLowerCase();
  for (const item of inventory) {
    const aliases = INVENTORY_ALIASES[item.id] ?? [item.name.toLowerCase()];
    if (aliases.some((alias) => lower.includes(alias) || alias.includes(lower))) {
      return { matched: true, itemId: item.id };
    }
  }
  return { matched: false };
}

export function parseMealQuery(
  query: string,
  inventory: InventoryItem[]
): Meal[] {
  const lower = query.toLowerCase();
  const meals: Meal[] = [];

  // Determine servings
  const peopleMatch = query.match(/(\d+)\s*(?:people|persons|friends|guests|servings)/i);
  const defaultServings = peopleMatch ? parseInt(peopleMatch[1]) : 2;

  // Determine timing
  const hasTonight = /tonight/.test(lower);
  const hasTomorrow = /tomorrow/.test(lower);
  const hasWeekend = /weekend/.test(lower);
  const hasToday = /\btoday\b/.test(lower);
  const hasNextDays = query.match(/next\s*(\d+)\s*days/i);

  // Find matching meal templates
  const matched = MEAL_TEMPLATES.filter((template) =>
    template.keywords.some((kw) => lower.includes(kw))
  );

  // Handle specific multi-meal requests
  if (lower.includes('three') || (hasNextDays && parseInt(hasNextDays[1]) >= 3)) {
    const dayCount = hasNextDays ? parseInt(hasNextDays[1]) : 3;
    const picks = matched.length >= dayCount ? matched.slice(0, dayCount) : pickFallbackMeals(dayCount, lower);
    for (let i = 0; i < picks.length; i++) {
      const when = i === 0 ? (hasToday || hasTonight ? 'Tonight' : 'Tomorrow') : `Day ${i + 1}`;
      meals.push(buildMeal(picks[i], defaultServings, when, inventory));
    }
    return meals;
  }

  // Handle "next 2 days" or "two days"
  if (hasNextDays && parseInt(hasNextDays[1]) === 2) {
    const picks = matched.length >= 2 ? matched.slice(0, 2) : pickFallbackMeals(2, lower);
    meals.push(buildMeal(picks[0], defaultServings, hasToday || hasTonight ? 'Today' : 'Tomorrow', inventory));
    meals.push(buildMeal(picks[1], defaultServings, 'Day 2', inventory));
    return meals;
  }

  if (lower.includes('two') || (lower.includes('next') && lower.includes('days'))) {
    const picks = matched.length >= 2 ? matched.slice(0, 2) : pickFallbackMeals(2, lower);
    meals.push(buildMeal(picks[0], defaultServings, hasToday || hasTonight ? 'Today' : 'Tomorrow', inventory));
    meals.push(buildMeal(picks[1], defaultServings, 'Day 2', inventory));
    return meals;
  }

  // Handle explicit "and" separator (e.g., "biryani tonight and pasta tomorrow")
  if (matched.length >= 2 && lower.includes(' and ')) {
    const when1 = hasTonight ? 'Tonight' : hasTomorrow ? 'Tomorrow' : 'Today';
    meals.push(buildMeal(matched[0], defaultServings, when1, inventory));
    meals.push(buildMeal(matched[1], defaultServings, hasTomorrow ? 'Tomorrow' : 'Day 2', inventory));
    return meals;
  }

  // Handle "healthy" / "high protein" generic requests
  if ((lower.includes('healthy') || lower.includes('high protein')) && matched.length === 0) {
    const pick = MEAL_TEMPLATES.find((t) => t.id === 'healthy-bowl')!;
    meals.push(buildMeal(pick, defaultServings, hasTonight || hasToday ? 'Tonight' : 'Tomorrow', inventory));
    return meals;
  }

  // Handle "breakfast" generic
  if (lower.includes('breakfast') && matched.length === 0) {
    const pick = MEAL_TEMPLATES.find((t) => t.id === 'pancakes')!;
    meals.push(buildMeal(pick, defaultServings, 'Tomorrow morning', inventory));
    return meals;
  }

  // Handle "snacks" / "party" / "friends"
  if ((lower.includes('snack') || lower.includes('party') || lower.includes('friends')) && matched.length === 0) {
    const pick = MEAL_TEMPLATES.find((t) => t.id === 'snacks-platter')!;
    meals.push(buildMeal(pick, defaultServings, hasWeekend ? 'This weekend' : 'Soon', inventory));
    return meals;
  }

  // Handle "south indian" generic
  if (lower.includes('south indian') && matched.length === 0) {
    const pick = MEAL_TEMPLATES.find((t) => t.id === 'south-indian-thali')!;
    meals.push(buildMeal(pick, defaultServings, hasToday || hasTonight ? 'Today' : 'Tomorrow', inventory));
    return meals;
  }

  // Fallback: use whatever matched, or a default
  if (matched.length > 0) {
    const when = hasTonight ? 'Tonight' : hasTomorrow ? 'Tomorrow' : hasWeekend ? 'This weekend' : 'Today';
    for (const template of matched.slice(0, 3)) {
      meals.push(buildMeal(template, defaultServings, when, inventory));
    }
    return meals;
  }

  // Ultimate fallback: suggest a simple meal
  const fallback = MEAL_TEMPLATES.find((t) => t.id === 'dal-rice')!;
  meals.push(buildMeal(fallback, defaultServings, hasTonight ? 'Tonight' : 'Tomorrow', inventory));
  return meals;
}

function pickFallbackMeals(count: number, query: string): MealTemplate[] {
  const lower = query.toLowerCase();
  let pool: MealTemplate[];
  if (lower.includes('vegetarian') || lower.includes('veg')) {
    pool = MEAL_TEMPLATES.filter((t) =>
      ['dal-rice', 'south-indian-thali', 'pasta', 'pancakes', 'fried-rice'].includes(t.id)
    );
  } else {
    pool = MEAL_TEMPLATES.filter((t) =>
      ['chicken-biryani', 'pasta', 'fried-rice', 'chicken-curry', 'healthy-bowl', 'dal-rice'].includes(t.id)
    );
  }
  return pool.slice(0, count);
}

function buildMeal(
  template: MealTemplate,
  servings: number,
  when: string,
  inventory: InventoryItem[]
): Meal {
  const ingredients = template.ingredients.map((ing) => {
    const match = matchIngredientToInventory(ing.name, inventory);
    return {
      ...ing,
      matchesInventory: match.matched,
      inventoryItemId: match.itemId,
    };
  });

  const haveItems = ingredients.filter((i) => i.matchesInventory);
  const needItems = ingredients.filter((i) => !i.matchesInventory);

  return {
    id: `meal-${template.id}-${when}`,
    name: template.name,
    emoji: template.emoji,
    servings,
    when,
    ingredients,
    haveItems,
    needItems,
  };
}

export function consolidateShopping(meals: Meal[]): MealIngredient[] {
  const map = new Map<string, MealIngredient & { mealNames: string[] }>();

  for (const meal of meals) {
    for (const ing of meal.needItems) {
      const key = ing.name.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.mealNames.push(meal.name);
      } else {
        map.set(key, { ...ing, mealNames: [meal.name] });
      }
    }
  }

  return Array.from(map.values());
}

// The preview's household insight (the real one is computed from orders).
export const SAMPLE_INSIGHT = {
  title: 'You shop for groceries about twice a week',
  detail: 'Usually on Wednesdays and weekends. Your most frequent purchases are milk, bread, and eggs.',
};
