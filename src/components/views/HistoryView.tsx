import type { PurchaseHistoryEntry, Toast as ToastType } from '../../types';
import { SOURCES } from '../../data';
import { MapPin, ChevronRight, Search, ShoppingCart, X } from 'lucide-react';
import { useState } from 'react';

import { RangePicker } from '@/components/RangePicker';
import { HISTORY_ROW_NAMES, SEARCH_MIN_CHARS } from '@/lib/constants';
import { summarizeNames } from '@/lib/list';
import type { Basket } from '@/lib/basket';
import { rangeText, withinRange, type RangeDays } from '@/lib/ranges';

interface HistoryViewProps {
  history: PurchaseHistoryEntry[];
  rangeDays: RangeDays;
  onRange: (days: RangeDays) => void;
  now: Date;
  // Putting a past order back in the cart. Absent on sample data.
  basket?: Basket;
  live?: boolean;
  showToast?: (toast: Omit<ToastType, 'id'>) => void;
}

// ₹4,230 → "₹4.2k"; small sums as they are.
const rupees = (n: number) => (n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`);

// What a household actually asks of its own history: "when did I last buy
// this, and what did I pay?" and "order that again". A list answers neither,
// which is why this page was only ever scrolled past.
export function HistoryView({ history, rangeDays, onRange, now, basket, live, showToast }: HistoryViewProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // The window filters what is read here and nothing else: rates and the
  // running-low list are still built from every order (src/lib/ranges.ts).
  const inRange = withinRange(history, rangeDays, now);
  // An order matches when something in it does. Matching on the app's own
  // product name too, so "amul" finds the butter.
  const q = query.trim().toLowerCase();
  const searching = q.length >= SEARCH_MIN_CHARS;
  const hits = (list: PurchaseHistoryEntry[]) => list.filter((e) => e.items.some((l) => `${l.name} ${l.product}`.toLowerCase().includes(q)));
  const shown = searching ? hits(inRange) : inRange;
  const found = searching ? matchingLines(inRange, q) : null;
  // What the window is hiding. A search that looks only inside the last
  // three months and says nothing about the rest is how "condoms" came back
  // empty when the last ones were bought nine months ago.
  const olderHits = searching && rangeDays !== null ? hits(history).length - shown.length : 0;
  const grouped = groupByDate(shown);
  // The address nearly every order goes to. Only a row that went somewhere
  // else says where: on 95% of rows the address was the same words again.
  const usualLocation = mostCommon(shown.map((e) => e.location).filter((l): l is string => !!l));

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6 scroll-area">
      <div className="mb-6 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900 mb-1">Purchase history</h1>
        {/* One fact. It used to add how many orders were OUTSIDE the window,
            which read as a warning about something nobody had done. */}
        <p className="text-sm text-ink-400">Your orders, in {rangeText(rangeDays)}.</p>
        <div className="mt-3">
          <RangePicker value={rangeDays} onChange={onRange} />
        </div>
        <div className="relative mt-3">
          <Search className="w-4 h-4 text-ink-300 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find something you bought"
            aria-label="Search what you have bought"
            className="w-full rounded-xl border border-sand-200 bg-surface py-2.5 pl-9 pr-9 text-sm focus:outline-none focus:border-sage-400"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear the search" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-300 hover:text-ink-600">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* The answer to "when did I last buy this, and what did I pay?" */}
      {found && found.buys > 0 && (
        <div className="card p-4 mb-6">
          <p className="text-sm text-ink-700">
            <span className="font-semibold">{found.buys}</span> {found.buys === 1 ? 'time' : 'times'} in {rangeText(rangeDays)}, {rupees(found.spend)} altogether.
          </p>
          <p className="text-xs text-ink-500 mt-1">
            Last on {found.lastDate}
            {found.low === found.high ? ` at ${rupees(found.low)}` : `, and ${rupees(found.low)} to ${rupees(found.high)} a time`}.
          </p>
        </div>
      )}

      {shown.length === 0 && (
        <div className="text-center py-16">
          <p className="text-sm text-ink-400">
            {history.length === 0
              ? 'No orders yet. They show up here as the import runs.'
              : searching
                ? `Nothing matching "${query.trim()}" in ${rangeText(rangeDays)}.`
                : 'No orders in this window. Try a wider range.'}
          </p>
          {olderHits > 0 && (
            <button onClick={() => onRange(null)} className="btn-secondary text-sm py-2 px-4 mt-4">
              {olderHits} {olderHits === 1 ? 'order' : 'orders'} further back. Search all time
            </button>
          )}
        </div>
      )}

      {/* Found some, but not all of them: say so rather than let the window
          quietly decide what exists. */}
      {shown.length > 0 && olderHits > 0 && (
        <button onClick={() => onRange(null)} className="w-full text-left text-xs text-ink-500 hover:text-ink-700 mb-4 underline underline-offset-2">
          {olderHits} more further back. Search all time
        </button>
      )}

      {/* Timeline */}
      <div className="space-y-6">
        {grouped.map((group) => (
          <div key={group.date}>
            <h2 className="text-xs font-semibold text-ink-400 uppercase tracking-wide mb-2 px-1">
              {group.date}
            </h2>
            <div className="space-y-2 stagger">
              {group.entries.map((entry) => {
                const source = SOURCES.find((s) => s.id === entry.source);
                const isExpanded = expandedId === entry.id;
                return (
                  <div key={entry.id} className="card card-hover overflow-hidden">
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                      className="w-full flex items-center gap-3 p-4 text-left"
                    >
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0"
                        style={{ backgroundColor: `${source?.color}15` }}
                      >
                        {source?.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        {/* One strong line and one quiet one. Everything used
                            to compete on the same row, so at phone width the
                            app's name wrapped and the email broke mid-word. */}
                        <div className="flex items-baseline gap-2">
                          {/* What was in it. "3 items" told nobody anything, and
                              the only way to know was to open every row. */}
                          <span className="text-sm font-semibold text-ink-700 min-w-0 truncate">
                            {summarizeNames(
                              entry.items.map((i) => (i.count > 1 ? `${i.name} ×${i.count}` : i.name)),
                              HISTORY_ROW_NAMES,
                            )}
                          </span>
                          {entry.onTheWay && <span className="chip bg-sage-100 text-sage-700 shrink-0">On the way</span>}
                          <span className="text-sm text-ink-700 ml-auto shrink-0">{rupees(entry.total)}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 text-2xs text-ink-400">
                          <span className="shrink-0">{source?.name}</span>
                          {entry.location && entry.location !== usualLocation && (
                            <>
                              <MapPin className="w-3 h-3 shrink-0" />
                              <span className="truncate">{entry.location}</span>
                            </>
                          )}
                          {entry.by && <span className="truncate">· {entry.by}</span>}
                        </div>
                      </div>
                      <ChevronRight className={`w-4 h-4 text-ink-300 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 animate-fade-in">
                        <div className="border-t border-sand-100 pt-3 space-y-2">
                          {entry.items.map((item, i) => (
                            <div key={i} className="flex items-center gap-3 py-1.5">
                              <span className="text-lg">{item.emoji}</span>
                              <div className="flex-1 min-w-0">
                                <span className="text-sm text-ink-700">{item.name}</span>
                                <span className="text-xs text-ink-400 ml-2">{item.quantity}</span>
                                <span className="block text-2xs text-ink-400 truncate">{item.product}</span>
                              </div>
                              {item.price > 0 && <span className="text-sm text-ink-500 shrink-0">₹{item.price}</span>}
                            </div>
                          ))}
                        </div>
                        {/* The thing a household actually wants from its own
                            history: this again. The same products, the same
                            packs, the same counts - not a guess at them. */}
                        {basket && (
                          <button
                            onClick={() => {
                              if (!live) {
                                showToast?.({ message: 'Sample data. Sign in to fill your own cart.', type: 'info' });
                                return;
                              }
                              let added = 0;
                              for (const l of entry.items) {
                                if (!l.product || basket.has(l.item)) continue;
                                basket.add({ item: l.item, name: l.name, emoji: l.emoji, product: l.product, pack: l.pack, qty: l.count });
                                added++;
                              }
                              showToast?.({
                                message: added
                                  ? `${added} ${added === 1 ? 'thing' : 'things'} on the list.`
                                  : 'Everything from that order is already on the list.',
                                type: added ? 'success' : 'info',
                              });
                            }}
                            className="btn-secondary text-sm py-2 px-4 mt-3"
                          >
                            <ShoppingCart className="w-4 h-4" />
                            Buy this again
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Every line matching the search, added up: how often, what it came to, the
// cheapest and dearest it has been, and when it was last bought. This is the
// answer to the question the page is really asked.
function matchingLines(history: PurchaseHistoryEntry[], q: string) {
  let buys = 0;
  let spend = 0;
  let low = Infinity;
  let high = 0;
  let lastDate = '';
  for (const entry of history) {
    for (const l of entry.items) {
      if (!`${l.name} ${l.product}`.toLowerCase().includes(q)) continue;
      buys++;
      spend += l.price;
      // Per one of it, so two in a basket is not read as a dearer thing.
      const each = l.count > 0 ? l.price / l.count : l.price;
      if (each > 0) {
        low = Math.min(low, each);
        high = Math.max(high, each);
      }
      // The history is newest first, so the first one seen is the last bought.
      if (!lastDate) lastDate = entry.date;
    }
  }
  return { buys, spend, low: low === Infinity ? 0 : low, high, lastDate };
}

function groupByDate(history: PurchaseHistoryEntry[]) {
  const groups: { date: string; entries: PurchaseHistoryEntry[] }[] = [];
  for (const entry of history) {
    const existing = groups.find((g) => g.date === entry.date);
    if (existing) existing.entries.push(entry);
    else groups.push({ date: entry.date, entries: [entry] });
  }
  return groups;
}

// The value that appears most; null when there are none.
function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  for (const [v, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = v;
  return best;
}
