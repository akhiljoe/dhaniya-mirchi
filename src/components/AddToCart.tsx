import { Plus, ShoppingCart } from 'lucide-react';

import type { InventoryItem, Toast } from '../types';
import { QtyStepper } from '@/components/QtyStepper';
import { firstChoice } from '@/components/YourProducts';
import type { Basket } from '@/lib/basket';
import { ADD_TO_CART_ENABLED } from '@/lib/constants';
import type { ProductPref } from '@/lib/products';

// Tapping must be instant: it puts the item on the cart list (basket.ts), and
// one Send fills them all in one trip through the app (design §19 stage 1).
//
// Everything the app SAYS about the cart - the line at the bottom, the sheet
// behind it, what went in and what did not - lives in CartDock. This file is
// only the button on a row.
export function AddToCart({
  item,
  pref,
  basket,
  live,
  showToast,
  compact = false,
  cartVendor = null,
}: {
  item: InventoryItem;
  pref: ProductPref | null;
  basket: Basket;
  live: boolean;
  showToast: (toast: Omit<Toast, 'id'>) => void;
  // A round + rather than a labelled button: for the one-line row, where a
  // labelled button on all 235 items was most of the page.
  compact?: boolean;
  // The app a cart would go to, so the product ticked is one it sells.
  cartVendor?: string | null;
}) {
  const product = firstChoice(item, pref, cartVendor);
  if (!ADD_TO_CART_ENABLED || !product) return null;
  const line = basket.lines.find((l) => l.item === item.id);

  // Once it is on the list the card counts it, the way the grocery apps do.
  // It said only "On the list" before, so there was no telling from here
  // whether one packet of milk was going or two - and no way to change it
  // without opening the review sheet.
  if (line) {
    return <QtyStepper qty={line.qty} name={item.name} onChange={(q) => basket.setQty(item.id, q)} onRemove={() => basket.remove(item.id)} />;
  }

  return (
    <button
      onClick={() => {
        if (!live) {
          showToast({ message: 'Sample data. Sign in to fill your own cart.', type: 'info' });
          return;
        }
        // Starts at what the household usually buys of it.
        basket.add({ item: item.id, name: item.name, emoji: item.emoji, product: product.name, pack: product.pack ?? '', qty: product.usualCount || 1 });
      }}
      aria-label={`Add ${item.name.toLowerCase()} to the list`}
      className={compact ? 'w-8 h-8 shrink-0 rounded-full border border-sand-300 text-sage-700 hover:bg-sand-100 flex items-center justify-center' : 'btn-secondary text-xs py-1.5 px-3 shrink-0'}
    >
      {compact ? (
        <Plus className="w-4 h-4" />
      ) : (
        <>
          <ShoppingCart className="w-3.5 h-3.5" />
          Add to cart
        </>
      )}
    </button>
  );
}
