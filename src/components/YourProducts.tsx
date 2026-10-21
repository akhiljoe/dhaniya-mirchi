import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, ShoppingCart, X } from 'lucide-react';

import type { InventoryItem, Toast } from '../types';
import type { Basket } from '@/lib/basket';
import { choiceForVendor, matchProducts, productKey, rankProducts, type Product, type ProductPref } from '@/lib/products';
import { PRODUCTS_SEARCH_FROM, PRODUCTS_SHOWN } from '@/lib/constants';

export type SavePref = (item: string, ranked: string[], blocked: string[]) => Promise<void>;

interface YourProductsProps {
  item: InventoryItem;
  pref: ProductPref | null;
  onSave?: SavePref; // absent: sample data, nothing to save to
  showToast: (toast: Omit<Toast, 'id'>) => void;
  // Adding a particular one straight from here. Absent on sample data.
  basket?: Basket;
}

// The product add to cart would add first, as the household ordered them.
// The product this household would be sent, for the app the cart is going to.
//
// `vendor` matters: their products carry the apps they were bought on, and
// sending one app's names to the other finds nothing. Left out, it keeps the
// old behaviour - their usual product, whoever sells it.
export function firstChoice(item: InventoryItem, pref: ProductPref | null, vendor?: string | null): Product | null {
  return choiceForVendor(rankProducts(item.products ?? [], pref).ranked, vendor ?? null);
}

// The ranking on its own, as a sheet (Home's running-low cards).
export function ProductsSheet(props: YourProductsProps & { onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 bg-scrim/30 backdrop-blur-sm z-40 animate-fade-in" onClick={props.onClose} />
      <div className="fixed bottom-0 left-0 right-0 md:top-1/2 md:left-1/2 md:bottom-auto md:translate-x-[-50%] md:translate-y-[-50%] md:w-[480px] z-50 sheet-surface rounded-t-3xl md:rounded-3xl shadow-soft-lg max-h-[85vh] overflow-y-auto scroll-area animate-slide-up md:animate-scale-in">
        <div className="md:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1.5 rounded-full bg-sand-300" />
        </div>
        <div className="p-6 pb-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{props.item.emoji}</span>
              <h2 className="font-display text-xl text-ink-900">{props.item.name}</h2>
            </div>
            <button onClick={props.onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-sand-100 text-ink-400">
              <X className="w-5 h-5" />
            </button>
          </div>
          <YourProducts item={props.item} pref={props.pref} onSave={props.onSave} showToast={props.showToast} basket={props.basket} />
        </div>
      </div>
    </>
  );
}

// Which product add to cart adds, in order (design §19 Ordering, "which
// product"). Starts as the household's own buying, most bought lately first;
// arrows reorder it, "Don't add" rules one out. Saved for the whole household.
export function YourProducts({ item, pref, onSave, showToast, basket }: YourProductsProps) {
  const start = rankProducts(item.products ?? [], pref);
  const [ranked, setRanked] = useState<Product[]>(start.ranked);
  const [blocked, setBlocked] = useState<Product[]>(start.blocked);
  const [saving, setSaving] = useState(false);
  // A long list needs a way through it: this household has 30 kinds of
  // chocolate. While a search is on, the arrows are hidden - the numbers mean
  // positions in the whole list, and moving #7 above #2 when #2 is filtered
  // out of sight would be a reorder nobody asked for.
  const [search, setSearch] = useState('');
  const names = (ps: Product[]) => ps.map((p) => productKey(p.name)).join('|');
  const changed = names(ranked) !== names(start.ranked) || names(blocked) !== names(start.blocked);

  const move = (i: number, by: -1 | 1) => {
    const next = [...ranked];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setRanked(next);
  };
  const block = (p: Product) => {
    setRanked(ranked.filter((x) => x !== p));
    setBlocked([...blocked, p]);
  };
  const allow = (p: Product) => {
    setBlocked(blocked.filter((x) => x !== p));
    setRanked([...ranked, p]);
  };
  const save = async (r: Product[], b: Product[], done: string) => {
    if (!onSave) {
      showToast({ message: 'Sample data. Sign in to set your own.', type: 'info' });
      return;
    }
    setSaving(true);
    try {
      await onSave(item.id, r.map((p) => p.name), b.map((p) => p.name));
      showToast({ message: done, type: 'success' });
    } catch {
      showToast({ message: 'Could not save. Please try again.', type: 'info' });
    }
    setSaving(false);
  };
  const reset = async () => {
    await save([], [], 'Back to the order you buy in.');
    const fresh = rankProducts(item.products ?? [], null);
    setRanked(fresh.ranked);
    setBlocked(fresh.blocked);
  };

  const searching = search.trim().length > 0;
  const shownRanked = matchProducts(ranked, search);
  const shownBlocked = matchProducts(blocked, search);

  const meta = (p: Product) =>
    [p.pack, p.recent > 0 ? `${p.recent}× lately` : `${p.total}× in all`].filter(Boolean).join(' · ');
  // The first few, with the rank arrows; the rest behind one line. Twenty-six
  // milks with Add, up, down and "Don't add" on each was 104 controls in one
  // sheet, and the two that mattered were the top two.
  const [showAll, setShowAll] = useState(false);
  const visibleRanked = searching || showAll ? shownRanked : shownRanked.slice(0, PRODUCTS_SHOWN);
  const hiddenCount = shownRanked.length - visibleRanked.length;
  const arrow = 'p-2 rounded-lg border border-sand-200 bg-surface text-ink-500 hover:border-sand-300 disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <ShoppingCart className="w-4 h-4 text-ink-400" />
        <span className="text-sm font-semibold text-ink-600">Your products</span>
      </div>
      <p className="text-xs text-ink-400 mb-3">
        {ranked.length > 1
          ? 'Add to cart tries these in order. If #1 is out of stock, #2 is added, and so on.'
          : 'What add to cart adds.'}
      </p>
      {ranked.length + blocked.length >= PRODUCTS_SEARCH_FROM && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Search ${ranked.length + blocked.length} products`}
          aria-label="Search your products"
          className="w-full mb-2 px-3 py-2 rounded-xl border border-sand-200 bg-surface text-xs focus:outline-none focus:border-sage-400"
        />
      )}
      {searching && shownRanked.length + shownBlocked.length === 0 && (
        <p className="text-xs text-ink-400 py-2">Nothing here matches that.</p>
      )}
      <div className="space-y-1.5">
        {visibleRanked.map((p: Product) => {
          const i = ranked.indexOf(p);
          return (
          <div key={p.name} className="flex items-center gap-2 py-2 px-3 rounded-lg bg-surface border border-sand-100">
            <span className="w-5 text-sm font-semibold text-ink-400 shrink-0">{i + 1}</span>
            <div className="flex-1 min-w-0">
              {/* Whole names. Clamped to two lines, "Akshayakalpa Amrutha A2
                  Pasteurized Organi..." and its neighbour could not be told
                  apart. */}
              <p className="text-sm font-medium text-ink-700 break-words">{p.name}</p>
              <p className="text-2xs text-ink-400">{meta(p)}</p>
            </div>
            {/* "Never add this one" as a small x, not a text link that read
                as a label. */}
            <button onClick={() => block(p)} aria-label={`Never add ${p.name}`} title="Never add" className="p-1.5 rounded-lg text-ink-300 hover:text-clay-600 hover:bg-sand-100 shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
            {/* Adding THIS one, rather than backing out and taking whatever
                is first in the order. Picking a brand and having no way to
                buy it was a dead end. */}
            {basket && (
              <button
                onClick={() => {
                  if (!onSave) {
                    showToast({ message: 'Sample data. Sign in to fill your own cart.', type: 'info' });
                    return;
                  }
                  // Already on the list: swap which product it is, rather
                  // than add the item twice.
                  if (basket.has(item.id)) basket.setProduct(item.id, p.name, p.pack ?? '');
                  else basket.add({ item: item.id, name: item.name, emoji: item.emoji, product: p.name, pack: p.pack ?? '', qty: p.usualCount || 1 });
                  showToast({ message: `${p.name} on the list.`, type: 'success' });
                }}
                className="text-2xs font-medium text-sage-700 shrink-0 px-2 py-1 rounded-md border border-sand-200 hover:bg-sand-100"
                aria-label={`Add ${p.name} to the list`}
              >
                Add
              </button>
            )}
            {ranked.length > 1 && !searching && (
              <div className="flex gap-1 shrink-0">
                <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${p.name} up`} className={arrow}>
                  <ChevronUp className="w-4 h-4" />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === ranked.length - 1} aria-label={`Move ${p.name} down`} className={arrow}>
                  <ChevronDown className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
          );
        })}
        {ranked.length === 0 && <p className="text-xs text-clay-600 py-2">Nothing left to add for this item.</p>}
        {hiddenCount > 0 && (
          <button onClick={() => setShowAll(true)} className="w-full text-left text-xs font-medium text-sage-700 hover:underline py-2 px-3">
            All {shownRanked.length} products
          </button>
        )}
      </div>

      {shownBlocked.length > 0 && (
        <div className="mt-3">
          <p className="text-2xs text-ink-400 uppercase tracking-wide mb-1.5">Never added</p>
          <div className="space-y-1.5">
            {shownBlocked.map((p: Product) => (
              <div key={p.name} className="flex items-center gap-2 py-2 px-3 rounded-lg bg-sand-100">
                <p className="flex-1 min-w-0 text-sm text-ink-500 line-through line-clamp-2">{p.name}</p>
                <button onClick={() => allow(p)} className="text-xs font-medium text-ink-500 hover:text-ink-700 shrink-0">
                  Allow
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(changed || pref) && (
        <div className="flex items-center gap-2 mt-3">
          {changed && (
            <button onClick={() => save(ranked, blocked, 'Saved. Add to cart will follow this order.')} disabled={saving} className="btn-primary text-sm py-2 px-4">
              {saving && <Loader2 className="w-4 h-4 animate-spin-slow" />}
              Save order
            </button>
          )}
          {pref && !changed && (
            <button onClick={reset} disabled={saving} className="btn-ghost text-xs">
              Go back to the order you buy in
            </button>
          )}
        </div>
      )}
    </div>
  );
}
