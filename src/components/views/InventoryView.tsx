import { useEffect, useRef, useState } from 'react';
import type { InventoryItem, Toast as ToastType } from '../../types';
import { SOURCES } from '../../data';
import { Check, ChevronDown, X, Clock, Loader2, RefreshCw, Search, TrendingUp, AlertCircle } from 'lucide-react';

import { ADD_TO_CART_ENABLED, CART_VENDOR, cartVendorInfo, type CartVendorInfo, HOME_PREFILL_CONFIDENCE, SEARCH_MIN_CHARS, SUPPLIES_ROWS_SHOWN } from '@/lib/constants';
import { runsOutText, type Insight } from '@/lib/household';
import type { PriceCompare } from '@/lib/insights';
import { lastPrice } from '@/lib/dock';
import { AddToCart } from '@/components/AddToCart';
import { QtyStepper } from '@/components/QtyStepper';
import { firstChoice, ProductsSheet, YourProducts, type SavePref } from '@/components/YourProducts';
import { lastOffer, rememberOffer, type Basket } from '@/lib/basket';
import type { ProductPref } from '@/lib/products';
import { splitEveryday } from '@/lib/list';

interface InventoryViewProps {
  inventory: InventoryItem[];
  // Which product to add for each item (design §19); saving needs sign-in.
  prefs: ProductPref[];
  basket: Basket; // items waiting to go into the vendor's cart
  onSavePref?: SavePref;
  onCorrectItem: (itemId: string, correction: 'more' | 'finished' | 'unsure') => void;
  showToast: (toast: Omit<ToastType, 'id'>) => void;
  // The first import is still running: an empty list means "not yet", not "none".
  learning?: boolean;
  // Signed in with an app connected, and nothing imported yet: fetch now.
  onSync?: () => void;
  syncing?: boolean;
  // Which app a cart goes to, and the apps it could go to. A household with
  // one connected app is never asked.
  cartVendor?: string;
  cartVendors?: CartVendorInfo[];
  onCartVendor?: (id: string) => void;
  // One thing the household did not know about how they shop. It was on Home
  // before Home was folded into this page.
  insight?: Insight | null;
  // The app's questions about the household (AskCards), asked here because
  // this is where the household is.
  asks?: React.ReactNode;
  // The same product and pack, cheaper on the other app (lib/insights.ts).
  // Said on the review sheet, where somebody is deciding what to send.
  compare?: PriceCompare[];
  // "We don't buy this any more": the item leaves the list for good, until
  // the household takes it back on the Household page. Absent on sample data.
  onRetire?: (item: InventoryItem) => void;
  // The full review of what could be sent, held by App because the cart
  // line at the bottom of every page is what opens it.
  reviewing?: boolean;
  onReviewingChange?: (open: boolean) => void;
}

// This is the app's landing page, and the whole of it.
//
// There was a Home tab in front of it for a while, and the trouble with it
// was that it had nothing of its own: strip out what Stock already showed and
// three things were left - the day's answer, the spend, and the basket. Three
// blocks cannot fill a screen, so it was padded with things that belonged
// elsewhere and it still looked unfinished. Worse, it could be EMPTY - a
// household that had turned today's list down saw a page with nothing on it.
//
// Those three things live at the top of this page now. This page is never
// empty, because the kitchen is always in it.
export function InventoryView({
  inventory,
  prefs,
  basket,
  onSavePref,
  onCorrectItem,
  showToast,
  learning = false,
  onSync,
  syncing = false,
  cartVendor = CART_VENDOR,
  insight,
  onRetire,
  asks,
  compare = [],
  reviewing = false,
  onReviewingChange,
}: InventoryViewProps) {
  const [filter, setFilter] = useState<'low' | 'soon' | 'plenty' | 'all'>('low');
  const setReviewing = (open: boolean) => onReviewingChange?.(open);
  const [query, setQuery] = useState('');
  // Each group shows a few rows and offers the rest. The page is a glance at
  // what to buy; the search is for finding one thing among 235.
  const [showAll, setShowAll] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [ranking, setRanking] = useState<InventoryItem | null>(null);
  // Change was opened from the Review sheet: go back there when it closes.
  const [backToReview, setBackToReview] = useState(false);
  const prefOf = (i: InventoryItem) => prefs.find((p) => p.item === i.id) ?? null;

  // Everything the app could offer to send today: what is running low, plus
  // the things bought most days.
  const flagged = inventory.filter((i) => i.status === 'likely-low');
  const { alerts: lowItems, everyday: everydayItems } = splitEveryday(flagged);
  const flaggedNow = [...lowItems, ...everydayItems];
  // Plus anything already on the list that is not flagged - something added
  // from the list below, or something bought since. Without this an item put
  // on the list by hand could not be counted or taken off again, because the
  // sheet only knew about what was running low.
  const candidates = [...flaggedNow, ...inventory.filter((i) => basket.has(i.id) && !flaggedNow.some((f) => f.id === i.id))];

  // The list the app makes up, offered when the household arrives at an
  // empty basket - and each thing on it offered ONCE.
  //
  // What is remembered is the list last offered (lib/basket.ts). Anything on
  // it is never put back by the app, however the household ended it: sent,
  // cleared, or taken off one at a time with the bin. Checking only "sent"
  // and "declined" missed that third ending, and the next visit to this
  // page made the same list up again ("I cleared all items, it again filled
  // it"). And when the running-low set gains one thing, only that one thing
  // is offered - not the whole list over again with the cleared ones back on
  // it.
  const signature = flaggedNow.map((i) => i.id).sort().join(',');
  const filled = useRef(false);
  useEffect(() => {
    // Nothing to offer yet: the orders have not arrived, or nothing is low.
    if (filled.current || !onSavePref || basket.lines.length || !candidates.length) return;
    filled.current = true;
    const before = new Set((lastOffer() ?? '').split(',').filter(Boolean));
    const fresh = flaggedNow.filter((i) => !before.has(i.id));
    if (!fresh.length) return;
    rememberOffer(signature);
    for (const item of fresh) {
      if (!HOME_PREFILL_CONFIDENCE.includes(item.confidence)) continue;
      // For the app this cart is going to: their products carry the apps
      // they were bought on, and one app's names find nothing at the other.
      const product = firstChoice(item, prefs.find((p) => p.item === item.id) ?? null, cartVendor);
      if (!product) continue;
      basket.add({ item: item.id, name: item.name, emoji: item.emoji, product: product.name, pack: product.pack ?? '', qty: product.usualCount || 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is what identifies the list
  }, [signature, basket, onSavePref, cartVendor]);



  // Matching the item's own name, what it is filed under, and the products
  // bought for it - so "amul" finds the butter and "dairy" finds the lot.
  const q = query.trim().toLowerCase();
  const searching = q.length >= SEARCH_MIN_CHARS;
  const matches = (item: InventoryItem) =>
    !searching || `${item.name} ${item.category} ${(item.products ?? []).map((p) => p.name).join(' ')}`.toLowerCase().includes(q);

  const filtered = inventory.filter((item) => {
    if (!matches(item)) return false;
    if (filter === 'all') return true;
    if (filter === 'low') return item.status === 'likely-low';
    if (filter === 'soon') return item.status === 'coming-up';
    if (filter === 'plenty') return item.status === 'plenty';
    return true;
  });

  // On the Running low filter, the things bought most days are shown apart:
  // their flag is right every day, so mixed in they bury the alerts that
  // actually changed (src/lib/list.ts).
  const grouped = filter === 'low' ? splitEveryday(filtered) : { alerts: filtered, everyday: [] as InventoryItem[] };

  // The same words the rows use - a row said "Coming up" under a tab called
  // "Not due", and the household asked which was true. In the order the day
  // goes: what is low now, what is coming up, what is not due, then
  // everything. Running low is where the page opens, because it is the
  // question the page is for. "Not due" rather than "Plenty": the rhythm
  // saying they are not due to buy it yet, not a claim about the fridge.
  const filters = [
    { id: 'low' as const, label: 'Running low' },
    { id: 'soon' as const, label: 'Coming up' },
    { id: 'plenty' as const, label: 'Not due' },
    { id: 'all' as const, label: 'All items' },
  ];

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6 scroll-area">
      <div className="mb-6 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900">
          {candidates.length === 0 ? 'Nothing urgent today' : `Order today: ${candidates.length} ${candidates.length === 1 ? 'thing' : 'things'}`}
        </h1>
        {!ADD_TO_CART_ENABLED && (
          <p className="text-xs text-ink-400 mt-2">Add to cart is coming soon: it will add items to your Instamart or Blinkit cart.</p>
        )}
      </div>

      {/* Search first. For a list of 235 things it is the primary control,
          and it sat under the heading, two cards and the filter chips, about
          1,300 px down - so nobody found it. */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 text-ink-300 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${inventory.length} things`}
          aria-label="Search what you have"
          className="w-full rounded-xl border border-sand-200 bg-surface py-2.5 pl-9 pr-9 text-sm focus:outline-none focus:border-sage-400"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear the search" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-300 hover:text-ink-600">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>


      {asks && <div className="mb-4">{asks}</div>}


      {/* Filter tabs */}
      <div className="flex gap-2 mb-5 overflow-x-auto no-scrollbar">
        {filters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
              filter === f.id
                ? 'bg-ink-800 text-sand-50'
                : 'bg-surface text-ink-500 border border-sand-200 hover:border-sand-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Items: a few of each group, and the rest on request. A search is a
          question about one thing, so it shows every match. */}
      <div className="space-y-2.5 stagger">
        {(searching || showAll ? grouped.alerts : grouped.alerts.slice(0, SUPPLIES_ROWS_SHOWN)).map((item) => (
          <InventoryCard
            key={item.id}
            item={item}
            cart={<AddToCart item={item} pref={prefOf(item)} basket={basket} live={!!onSavePref} showToast={showToast} cartVendor={cartVendor} compact />}
            onClick={() => setSelectedItem(item)}
          />
        ))}
      </div>

      {grouped.everyday.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide mt-8 mb-3">You buy these most days</h2>
          <div className="space-y-2.5 stagger">
            {(searching || showAll ? grouped.everyday : grouped.everyday.slice(0, SUPPLIES_ROWS_SHOWN)).map((item) => (
              <InventoryCard
                key={item.id}
                item={item}
                cart={<AddToCart item={item} pref={prefOf(item)} basket={basket} live={!!onSavePref} showToast={showToast} cartVendor={cartVendor} compact />}
                onClick={() => setSelectedItem(item)}
              />
            ))}
          </div>
        </>
      )}

      {!searching && filtered.length > SUPPLIES_ROWS_SHOWN && (
        <button onClick={() => setShowAll((v) => !v)} className="btn-secondary text-sm py-2.5 px-4 mt-4 w-full justify-center">
          {showAll ? (
            'Show fewer'
          ) : (
            <>
              Show all {filtered.length}
              <ChevronDown className="w-4 h-4" />
            </>
          )}
        </button>
      )}

      {filtered.length === 0 && (
        <div className="text-center py-16">
          <p className="text-ink-400 text-sm">
            {searching
              ? `Nothing matching "${query.trim()}".`
              : learning && inventory.length === 0
                ? 'Still reading your orders. Items show up here as they come in.'
                : 'No items in this category.'}
          </p>
          {/* Nothing imported and nothing importing: the household can ask
              for their orders now rather than wait for the next sweep. */}
          {!learning && inventory.length === 0 && onSync && (
            <button onClick={onSync} disabled={syncing} className="btn-secondary text-sm py-2 px-4 mt-4">
              {syncing ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <RefreshCw className="w-4 h-4" />}
              {syncing ? 'Looking for orders' : 'Look for new orders'}
            </button>
          )}
        </div>
      )}

      {reviewing && (
        <BasketSheet
          items={candidates}
          prefOf={prefOf}
          onRank={(item) => {
            // One sheet at a time. Opened on top, the lower sheet's close was
            // under the upper one and backing out took three tries.
            setReviewing(false);
            setBackToReview(true);
            setRanking(item);
          }}
          basket={basket}
          live={!!onSavePref}
          showToast={showToast}
          compare={compare}
          cartVendor={cartVendor}
          onClose={() => setReviewing(false)}
        />
      )}

      {insight && (
        <section className="mt-8">
          <div className="flex items-start gap-3 p-4 rounded-2xl bg-sage-50 border border-sage-200">
            <div className="w-9 h-9 rounded-lg bg-sage-100 flex items-center justify-center shrink-0">
              <TrendingUp className="w-5 h-5 text-sage-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-700 mb-0.5">{insight.title}</p>
              <p className="text-xs text-ink-500 leading-relaxed">{insight.detail}</p>
            </div>
          </div>
        </section>
      )}

      {ranking && (
        <ProductsSheet
          item={ranking}
          pref={prefOf(ranking)}
          onSave={onSavePref}
          showToast={showToast}
          basket={basket}
          onClose={() => {
            setRanking(null);
            if (backToReview) {
              setBackToReview(false);
              setReviewing(true);
            }
          }}
        />
      )}

      {/* Detail sheet */}
      {selectedItem && (
        <ItemDetailSheet
          item={selectedItem}
          pref={prefs.find((p) => p.item === selectedItem.id) ?? null}
          onSavePref={onSavePref}
          showToast={showToast}
          basket={basket}
          onClose={() => setSelectedItem(null)}
          onRetire={
            onRetire &&
            (() => {
              onRetire(selectedItem);
              setSelectedItem(null);
            })
          }
          onCorrect={(c) => {
            onCorrectItem(selectedItem.id, c);
            if (c === 'more') showToast({ message: `Updated. You have more ${selectedItem.name.toLowerCase()} than we thought.`, type: 'success' });
            if (c === 'finished') showToast({ message: `Marked ${selectedItem.name.toLowerCase()} as finished`, type: 'success' });
            if (c === 'unsure') showToast({ message: `We'll keep learning about ${selectedItem.name.toLowerCase()}`, type: 'info' });
            setSelectedItem(null);
          }}
        />
      )}
    </div>
  );
}

// One thing, one row. The card this replaces carried seven elements - a
// tile, the name, a confidence dot, the estimate, a status pill, a chevron, a
// "Correct this estimate" link and an Add button - and there are 235 of them,
// which made the page 70,000 px tall. The status is now a coloured word in
// the second line rather than a pill (under the Running low filter every pill
// said the filter's own name), the correction lives in the sheet where the
// one item somebody is actually correcting is open, the chevron is gone
// because the row is the tap target, and the confidence dot is gone because
// nothing anywhere said what it meant.
function InventoryCard({ item, cart, onClick }: { item: InventoryItem; cart: React.ReactNode; onClick: () => void }) {
  const status = ROW_STATUS[item.status];
  const note =
    item.userCorrected === 'more' ? 'you said you have more' : item.userCorrected === 'finished' ? 'you said it is finished' : null;
  return (
    <div className="card px-3 py-2.5 card-hover flex items-center gap-3">
      <button onClick={onClick} className="flex items-center gap-3 flex-1 min-w-0 text-left">
        <div className="w-9 h-9 rounded-lg bg-sand-100 flex items-center justify-center text-xl shrink-0">{item.emoji}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-ink-800 truncate">{item.name}</p>
          <p className="text-xs text-ink-500 truncate">
            <span className={status.color}>{status.label}</span>
            {' · '}
            {item.estimatedAmount}
            {note && ` · ${note}`}
          </p>
        </div>
      </button>
      {cart}
    </div>
  );
}

// The status as a word in the row, coloured. No pill: the colour carries it.
const ROW_STATUS: Record<InventoryItem['status'], { label: string; color: string }> = {
  'likely-low': { label: 'Running low', color: 'text-clay-600 font-medium' },
  'coming-up': { label: 'Coming up', color: 'text-ink-600 font-medium' },
  'plenty': { label: 'Not due', color: 'text-sage-700 font-medium' },
  'unknown': { label: 'Unsure', color: 'text-ink-400 font-medium' },
};

function ItemDetailSheet({
  item,
  pref,
  onSavePref,
  showToast,
  basket,
  onClose,
  onCorrect,
  onRetire,
}: {
  item: InventoryItem;
  pref: ProductPref | null;
  onSavePref?: InventoryViewProps['onSavePref'];
  showToast: InventoryViewProps['showToast'];
  // So a particular brand can go on the list from right here.
  basket: Basket;
  onClose: () => void;
  onCorrect: (c: 'more' | 'finished' | 'unsure') => void;
  onRetire?: () => void;
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-scrim/30 backdrop-blur-sm z-40 animate-fade-in"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="fixed bottom-0 left-0 right-0 md:top-1/2 md:left-1/2 md:bottom-auto md:translate-x-[-50%] md:translate-y-[-50%] md:w-[480px] z-50 sheet-surface rounded-t-3xl md:rounded-3xl shadow-soft-lg max-h-[85vh] overflow-y-auto scroll-area animate-slide-up md:animate-scale-in">
        {/* Handle */}
        <div className="md:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1.5 rounded-full bg-sand-300" />
        </div>

        <div className="p-6">
          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-sand-100 flex items-center justify-center text-3xl">
                {item.emoji}
              </div>
              <div>
                <h2 className="font-display text-xl text-ink-900">{item.name}</h2>
                <p className="text-sm text-ink-400">{item.category}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-sand-100 text-ink-400">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Estimate */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="card p-4">
              <div className="text-2xs text-ink-400 uppercase tracking-wide mb-1">Estimated</div>
              <div className="text-lg font-semibold text-ink-800">{item.estimatedAmount}</div>
            </div>
            <div className="card p-4">
              <div className="text-2xs text-ink-400 uppercase tracking-wide mb-1">Likely runs out in</div>
              <div className="text-lg font-semibold text-ink-800">
                {runsOutText(item.daysUntilLow)}
              </div>
            </div>
          </div>

          {/* Confidence: the label on one line, the reason under it. Side by
              side, a long reason folded the label onto two lines. */}
          <div className="flex flex-col gap-1 mb-6">
            <div className="flex items-center gap-1.5">
              {item.confidence === 'high' && <span className="w-2 h-2 rounded-full bg-sage-400" />}
              {item.confidence === 'medium' && <span className="w-2 h-2 rounded-full bg-clay-300" />}
              {item.confidence === 'low' && <span className="w-2 h-2 rounded-full bg-ink-300" />}
              <span className="text-sm font-medium text-ink-600">
                {item.confidence === 'high' && 'High confidence'}
                {item.confidence === 'medium' && 'Medium confidence'}
                {item.confidence === 'low' && 'Low confidence'}
              </span>
            </div>
            {/* The true reason, from the engine. "Not enough purchase history"
                was said about milk bought 135 times; the reason there was
                that the amount per buy varied too much for one rate. */}
            {item.confidence !== 'high' && confidenceReasonText(item) && (
              <span className="flex items-center gap-1 text-xs text-ink-400">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {confidenceReasonText(item)}
              </span>
            )}
          </div>
          {/* What the confidence is NOT about. The rhythm is a separate fact
              and often the strong one: milk every day for 135 buys is as sure
              as the app gets, whatever it thinks about the amount left. */}
          {item.purchaseFrequency.startsWith('Every') && item.history.length >= 2 && (
            <p className="text-xs text-ink-500 -mt-4 mb-6">
              Bought {item.purchaseFrequency.toLowerCase()}, {item.history.length} times. That part is certain.
            </p>
          )}

          {/* Why */}
          <div className="rounded-2xl bg-sage-50 border border-sage-200 p-4 mb-6">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-sage-600" />
              <span className="text-sm font-semibold text-ink-700">Why this estimate?</span>
            </div>
            <p className="text-sm text-ink-600 leading-relaxed">
              {item.purchaseFrequency.startsWith('Every') ? (
                <>
                  You usually buy {item.typicalQuantity} of {item.name.toLowerCase()}{' '}
                  {item.purchaseFrequency.toLowerCase()}. Your last purchase was {item.lastPurchased.toLowerCase()}.
                </>
              ) : (
                <>
                  {item.estimatedAmount}, so we can't estimate it yet. Your last purchase was{' '}
                  {item.lastPurchased.toLowerCase()}.
                </>
              )}
            </p>
          </div>

          {item.products && item.products.length > 0 && (
            <YourProducts item={item} pref={pref} onSave={onSavePref} showToast={showToast} basket={basket} />
          )}

          {/* Purchase history */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="w-4 h-4 text-ink-400" />
              <span className="text-sm font-semibold text-ink-600">Recent purchases</span>
            </div>
            <div className="space-y-1.5">
              {item.history.slice(0, 5).map((p) => (
                <div key={p.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface border border-sand-100">
                  <div>
                    <span className="text-sm font-medium text-ink-700">{p.date}</span>
                    <span className="text-xs text-ink-400 ml-2">{p.quantity}</span>
                  </div>
                  {p.price > 0 && <span className="text-sm text-ink-500">₹{p.price}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Correction */}
          <div>
            <p className="text-sm font-semibold text-ink-600 mb-2">Is this estimate off?</p>
            <div className="flex gap-2">
              <button
                onClick={() => onCorrect('more')}
                className="flex-1 btn-secondary text-xs py-2.5"
              >
                I have more
              </button>
              <button
                onClick={() => onCorrect('finished')}
                className="flex-1 btn-secondary text-xs py-2.5"
              >
                Already finished
              </button>
              <button
                onClick={() => onCorrect('unsure')}
                className="flex-1 btn-secondary text-xs py-2.5"
              >
                Not sure
              </button>
            </div>
            {/* The control a stranger asked for first. The app showed things
                it should have known to stop showing - a wallet bought once,
                pads for a dog that has gone - and offered no way to say so. */}
            {onRetire && (
              <button onClick={onRetire} className="mt-3 text-xs font-medium text-ink-500 hover:text-clay-700">
                We don't buy {item.name.toLowerCase()} any more
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const money = (n: number) => (n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`);



// One thing, added to the list in a tap. The price is what they last paid
// for it, which is the only price we have any business showing.

// "₹12 more and delivery is free." The store charges the fee below a figure
// it names itself, and the household was paying it without being told how
// close they were. Nothing here is suggested that costs more than the fee it
// saves - that is the store's interest, not theirs (lib/topup.ts), so when
// nothing they buy fits the window this says the gap and stops.

// The reason beside a confidence that is not high, in words that point at
// what would change it. Null when there is nothing worth saying.
function confidenceReasonText(item: InventoryItem): string | null {
  switch (item.confidenceReason) {
    case 'uneven':
      return 'The amount per buy varies a lot, so the amount left is a rough guess';
    case 'stale':
      return 'Not bought for a while, so the estimate has gone cold';
    case 'stated':
      return 'Based on what you told us you use, not on purchases yet';
    case 'few':
      return 'Not enough purchases yet to be sure';
    default:
      return null;
  }
}

// The same product and pack, cheaper on an app that is not the one this
// cart goes to. Null when it is not, or when the cheaper one IS this app.
function cheaperOn(compare: PriceCompare[], product: { name: string; pack?: string | null } | null): PriceCompare | null {
  if (!product?.pack) return null;
  const found = compare.find((c) => c.product === product.name && c.pack === product.pack);
  // `cheaper` is the vendor's id, not its name.
  return found && found.cheaper !== CART_VENDOR ? found : null;
}

// The app's name as the household sees it.
const appName = (vendor: string) => SOURCES.find((s) => s.id === vendor)?.name ?? vendor;

// The full list, in a sheet rather than down the middle of Home: tick,
// untick, change which product, and see what each last cost.
function BasketSheet({
  items,
  prefOf,
  onRank,
  basket,
  live,
  showToast,
  compare,
  cartVendor,
  onClose,
}: {
  items: InventoryItem[];
  prefOf: (item: InventoryItem) => ProductPref | null;
  onRank: (item: InventoryItem) => void;
  basket: Basket;
  live: boolean;
  showToast: (toast: Omit<ToastType, 'id'>) => void;
  compare: PriceCompare[];
  // The app this basket is bound for, so the sheet names it rather than a
  // constant that is only right for one of them.
  cartVendor: string | null;
  onClose: () => void;
}) {
  const ticked = items.filter((i) => basket.has(i.id));
  // Ticked first, then the rest: what is going is what somebody opens this
  // to check, and it was scattered through twenty rows in the list's own
  // order. The split is fixed when the sheet opens - unticking something
  // must not make it jump to the bottom under the finger that did it.
  const [wasTicked] = useState(() => new Set(ticked.map((i) => i.id)));
  const ordered = [...items.filter((i) => wasTicked.has(i.id)), ...items.filter((i) => !wasTicked.has(i.id))];
  const firstUnticked = items.filter((i) => wasTicked.has(i.id)).length;
  return (
    <>
      <div className="fixed inset-0 bg-scrim/30 backdrop-blur-sm z-40 animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="What to send"
        className="fixed bottom-0 left-0 right-0 md:top-1/2 md:left-1/2 md:bottom-auto md:translate-x-[-50%] md:translate-y-[-50%] md:w-[440px] z-50 sheet-surface rounded-t-3xl md:rounded-3xl shadow-soft-lg max-h-[85vh] overflow-y-auto scroll-area animate-slide-up md:animate-scale-in"
      >
        <div className="md:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1.5 rounded-full bg-sand-300" />
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-xl text-ink-900">What to send</h2>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-sand-100 text-ink-400">
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-xs text-ink-400 mb-3">
            {ticked.length} of {items.length} ticked.
          </p>
          <div className="space-y-1">
            {ordered.map((item, idx) => {
              const on = basket.has(item.id);
              const product = firstChoice(item, prefOf(item));
              const price = lastPrice(item);
              const line = basket.lines.find((l) => l.item === item.id);
              return (
                <div key={item.id} className="py-1">
                  {idx === firstUnticked && firstUnticked > 0 && idx < ordered.length && (
                    <p className="text-2xs uppercase tracking-wide text-ink-400 pt-3 pb-1.5 border-t border-sand-200 mt-1">
                      Not ticked. We were not sure about these.
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (!live) {
                          showToast({ message: 'Sample data. Sign in to fill your own cart.', type: 'info' });
                          return;
                        }
                        if (on) basket.remove(item.id);
                        else if (product)
                          basket.add({ item: item.id, name: item.name, emoji: item.emoji, product: product.name, pack: product.pack ?? '', qty: product.usualCount || 1 });
                      }}
                      className="flex-1 min-w-0 flex items-center gap-3 py-1 px-1 rounded-lg hover:bg-sand-100 text-left"
                      aria-pressed={on}
                    >
                      <span
                        className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${on ? 'bg-sage-600 border-sage-600' : 'border-sand-300'}`}
                        aria-hidden
                      >
                        {on && <Check className="w-3.5 h-3.5 text-sand-50" />}
                      </span>
                      <span className="text-lg shrink-0">{item.emoji}</span>
                      <span className={`flex-1 min-w-0 text-sm truncate ${on ? 'text-ink-800' : 'text-ink-500'}`}>{item.name}</span>
                    </button>
                    {/* How many, and the same stepper the cards carry. It was
                        the household settings one, which disables its own
                        minus at its floor - so the one thing somebody wanted
                        to drop could not be dropped from here. */}
                    {on && line && (
                      <QtyStepper qty={line.qty} name={item.name} onChange={(q) => basket.setQty(item.id, q)} onRemove={() => basket.remove(item.id)} />
                    )}
                  </div>
                  <div className="flex items-baseline gap-2 pl-9">
                    <span className="flex-1 min-w-0 text-2xs text-ink-400 truncate">
                      {[price !== null ? money(price) : null, product?.pack, product?.name].filter(Boolean).join(' · ')}
                    </span>
                    {product && live && (
                      <button
                        onClick={() => onRank(item)}
                        className="text-2xs font-medium text-sage-700 shrink-0 px-2 py-0.5 rounded-md hover:bg-sand-100"
                        aria-label={`Change which ${item.name.toLowerCase()} to send`}
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {/* Never once bought on the app this cart goes to. Evidence,
                      not a catalogue - it still goes in if they want it. */}
                  {on && product && cartVendor && !product.vendors.includes(cartVendor) && product.vendors.length > 0 && (
                    <p className="text-2xs text-clay-700 pl-9 mt-0.5">
                      You buy this on {appName(product.vendors[0])}, not {cartVendorInfo(cartVendor).name}.
                    </p>
                  )}
                  {/* The one comparison nobody else can make for this
                      household, said where it can change a decision. On
                      Insights it only ever reached somebody with no cart in
                      their hand. */}
                  {on && cheaperOn(compare, product) && (
                    <p className="text-2xs text-sage-700 pl-9 mt-0.5">
                      {money(cheaperOn(compare, product)!.saving)} less on {appName(cheaperOn(compare, product)!.cheaper)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <button onClick={onClose} className="btn-primary text-sm py-2.5 px-5 mt-5 w-full justify-center">
            Done
          </button>
        </div>
      </div>
    </>
  );
}
