import type { Product } from '@/lib/products';

export type Confidence = 'high' | 'medium' | 'low';

export type SourceId = 'email' | 'blinkit' | 'zepto' | 'instamart';

export interface Source {
  id: SourceId;
  name: string;
  description: string;
  icon: string;
  color: string;
  connected: boolean;
  lastSynced?: string;
  ordersImported?: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  emoji: string;
  category: string;
  unit?: 'ml' | 'g' | 'piece'; // the canonical unit its amounts are in
  estimatedAmount: string;
  daysUntilLow: number | null; // null: no rate yet — never shown as a number
  // Days since last bought ÷ the usual gap: 1 = due now, 2 = twice overdue.
  // null without a usual gap. Orders the running-low list.
  dueRatio?: number | null;
  // The usual gap between purchases, in days; null without one. Orders the
  // running-low list (most often bought first).
  usualGapDays?: number | null;
  // How likely it is bought within the next few days (engine due.ts); null
  // without enough history. Orders the running-low list, most likely first.
  likelihood?: number | null;
  confidence: Confidence;
  // Why it is not higher (engine ConfidenceReason). Null: nothing to explain.
  confidenceReason?: 'few' | 'uneven' | 'stale' | 'stated' | null;
  lastPurchased: string; // as shown ("yesterday")
  lastPurchasedAt?: string; // the instant, ISO: what a correction is compared to. Absent on sample data.
  purchaseFrequency: string;
  typicalQuantity: string;
  history: PurchaseRecord[];
  // The products bought for it, most bought lately first (lib/products.ts).
  products?: Product[];
  status: 'likely-low' | 'coming-up' | 'plenty' | 'unknown';
  userCorrected?: 'more' | 'finished' | 'unsure' | null;
}

export interface PurchaseRecord {
  id: string;
  date: string;
  source: SourceId;
  quantity: string;
  price: number;
}

export interface ShoppingListItem {
  id: string;
  name: string;
  emoji: string;
  reason: string;
  urgency: 'soon' | 'coming-up';
  confidence: Confidence;
  status: 'pending' | 'confirmed' | 'dismissed' | 'purchased' | 'snoozed';
  snoozedUntil?: string;
}

export interface PurchaseHistoryEntry {
  id: string;
  date: string; // as shown ("Sep 9", "Yesterday")
  at: string; // the instant it was placed, ISO: what a date range filters on
  items: {
    // The canonical item ("milk"), the app's own product name and its pack:
    // enough to put the same thing in a cart again without guessing.
    item: string;
    product: string;
    pack: string;
    count: number;
    name: string;
    emoji: string;
    quantity: string;
    price: number;
  }[];
  source: SourceId;
  total: number;
  location?: string;
  // Who placed it, when the household has several people's accounts.
  by?: string;
  onTheWay?: boolean; // ordered, not delivered yet

}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'info' | 'undo';
  undoAction?: () => void;
}

export type AppStage =
  | 'welcome'
  | 'signin'
  | 'join'
  | 'connect'
  | 'auth'
  | 'importing'
  | 'learned'
  | 'main';

export interface MealIngredient {
  name: string;
  emoji: string;
  quantity: string;
  category: string;
  matchesInventory?: boolean;
  inventoryItemId?: string;
}

export interface Meal {
  id: string;
  name: string;
  emoji: string;
  servings: number;
  when: string;
  ingredients: MealIngredient[];
  haveItems: MealIngredient[];
  needItems: MealIngredient[];
}

export interface MealPlan {
  id: string;
  query: string;
  meals: Meal[];
  consolidatedShopping: MealIngredient[];
  createdAt: string;
}

// 'home' is gone: it had nothing of its own that the inventory page did not
// already show, and could be empty on a day when the household had turned
// today's list down. Its three blocks live at the top of 'inventory', which
// is the landing page now.
export type MainView = 'inventory' | 'cook' | 'history' | 'insights' | 'apps' | 'meals' | 'household' | 'how' | 'ai';
export const MAIN_VIEWS: MainView[] = ['inventory', 'cook', 'history', 'insights', 'apps', 'meals', 'household', 'how', 'ai'];
// Where the landing page is. Anything that used to say 'home' lands here.
export const LANDING_VIEW: MainView = 'inventory';
