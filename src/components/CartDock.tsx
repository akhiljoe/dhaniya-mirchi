import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Loader2, Plus, ShoppingCart, Trash2, X } from 'lucide-react';

import type { InventoryItem, Toast } from '../types';
import { Stepper } from '@/components/HouseholdQuick';
import { PayNow } from '@/components/PayNow';
import type { Basket, BasketLine } from '@/lib/basket';
import { declineBasket, lastOffer } from '@/lib/basket';
import {
  CART_ERROR_FALLBACK,
  CART_ERROR_TEXT,
  cartRaceWarning,
  cartSecondsLeft,
  inCartFromCart,
  timeLeftText,
  type CartBill,
  type CartJobSummary,
} from '@/lib/cart';
import { ADD_TO_CART_ENABLED, CART_VENDOR_INFO, cartVendorInfo, type CartVendorInfo, ORDER_MAX_RUPEES, PAY_ENABLED, SEEN_LIST_LINE_KEY } from '@/lib/constants';
import { dockState, elsewhereFor, estimateFor, idsOf, lastPrice, payable } from '@/lib/dock';
import type { ProductPref } from '@/lib/products';
import { useSeen } from '@/lib/seen';
import { topUpForFreeDelivery } from '@/lib/topup';

// The cart, in one place: a line above the navigation and a sheet behind it.
//
// This is the whole of what the app says about a cart, on every page. It
// replaced two cards at the top of Supplies and a bar that hid behind them -
// three surfaces for one thing (lib/dock.ts has the story). What the line
// says comes from `dockState`; this file only draws it, so the look can be
// changed again without the story changing.
//
// The grocery apps' own pattern, deliberately: one line with the amount, tap
// it for the items. The household already knows how to read it.
//
// ONE sheet, with a tab for each thing there is: the list being made, and a
// cart on each app. There were two sheets once, and with milk on the list and
// a Blinkit cart ready, a tap on the line landed on the cart and not the
// milk. Whatever is tapped, the list is now one tab away.
export function CartDock({
  basket,
  active,
  jobs,
  dismissed,
  onDismiss,
  sending,
  onSend,
  onStop,
  cartVendor,
  cartVendors,
  onCartVendor,
  cardsFor,
  inventory,
  prefs,
  delivery,
  onMoreItems,
  live,
  showToast,
  vendorChosen = false,
  fallback = true,
  showList = true,
}: {
  basket: Basket;
  active: CartJobSummary[];
  // Every cart job this household has: the line shows the newest finished
  // one on EACH app, because with two apps there can be a cart on each.
  jobs: CartJobSummary[];
  // The finished carts the household pushed away, by id (lib/seen.ts).
  dismissed: string | null;
  onDismiss: (jobId: string) => void;
  sending: boolean;
  // Send these lines to this app. The lines are passed rather than read off
  // the basket, because the "send the rest to the other app" tap sends lines
  // that were never on it.
  onSend: (vendor: string, lines: BasketLine[]) => void;
  onStop: (jobId: string) => void;
  cartVendor: string;
  cartVendors: CartVendorInfo[];
  onCartVendor?: (id: string) => void;
  cardsFor: (vendor: string) => string[];
  inventory: InventoryItem[];
  prefs: ProductPref[];
  delivery?: { fee: number | null; freeAbove: number | null };
  // Opens the full review on Supplies: everything that could be sent, with
  // the product choice for each. Absent where there is no such page.
  onMoreItems?: () => void;
  live: boolean;
  showToast: (toast: Omit<Toast, 'id'>) => void;
  // Set on the Grocery apps page. With an app chosen, the list offers only
  // that app; with the fallback off, the other app is never offered for what
  // the chosen one lacks.
  vendorChosen?: boolean;
  fallback?: boolean;
  // Whether the list being made is shown on this page. Ready carts always are.
  showList?: boolean;
}) {
  // Which tab the sheet is open on: 'list', or an app id. Null: closed.
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<CartJobSummary | null>(null);
  // The things another app has, as the household has edited them: held here
  // rather than in the sheet, so closing the sheet does not put back what
  // was just taken off ("I cleared all items, it again filled it").
  const [edited, setEdited] = useState<Record<string, BasketLine[]>>({});
  const state = dockState({ basket: basket.lines, active, jobs, dismissed, vendor: cartVendor, now: new Date() });
  // The list whose line was pushed away, by WHICH list it was. The items stay
  // on the list and on their rows; only the line goes, and it comes back the
  // moment the list changes. Through useSeen so a reload does not bring it
  // back (lib/seen.ts).
  const [hiddenList, hideList] = useSeen(SEEN_LIST_LINE_KEY);
  const listSignature = basket.lines
    .map((l) => l.item)
    .sort()
    .join(',');

  const readyJobs = state.kind === 'ready' ? state.jobs : state.kind === 'picking' ? state.ready : [];
  const failedJobs = state.kind === 'failed' ? [state.job] : state.kind === 'ready' ? state.failed : [];
  const hasSheet = basket.lines.length > 0 || readyJobs.length > 0 || failedJobs.length > 0;

  // The sheet closes when there is nothing left for it to be about.
  useEffect(() => {
    if (open !== null && (!hasSheet || state.kind === 'filling')) setOpen(null);
  }, [open, hasSheet, state.kind]);

  if (!ADD_TO_CART_ENABLED || state.kind === 'hidden') return null;
  if (state.kind === 'picking' && hiddenList === listSignature && open === null) return null;
  if (state.kind === 'picking' && !showList && !state.ready.length && open === null) return null;

  return (
    <>
      <div className="fixed left-0 right-0 bottom-14 md:bottom-0 z-30 px-4 pb-2">
        <div className="relative max-w-3xl mx-auto card shadow-soft-lg p-3 flex items-center gap-3">
          {/* Off the list's pages, a list being made steps aside and any ready
              cart takes the line: paying is reachable from anywhere, the list
              is changed on Supplies and Cook. */}
          {state.kind === 'picking' && !showList && state.ready.length > 0 && (
            <ReadyLine jobs={state.ready} onOpen={() => setOpen(state.ready[0].vendor)} onPay={setPaying} />
          )}
          {state.kind === 'picking' && showList && (
            <PickingLine
              lines={state.lines}
              vendor={state.vendor}
              inventory={inventory}
              delivery={delivery}
              ready={state.ready}
              sending={sending}
              onOpen={() => setOpen('list')}
              onOpenReady={() => setOpen(state.ready[0]?.vendor ?? 'list')}
              onSend={() => onSend(state.vendor, basket.lines)}
              onHide={() => {
                // The app made this list up without being asked, so pushing
                // its line away is saying no to THAT list: what was offered
                // comes off and is not offered again, and anything the
                // household put on themselves stays. Before this the offered
                // things stayed hidden on the list, and adding one thing by
                // hand brought back four ("I add one, I see 4").
                const offered = (lastOffer() ?? '').split(',').filter(Boolean);
                const stillOffered = basket.lines.filter((l) => offered.includes(l.item));
                if (stillOffered.length) {
                  declineBasket(lastOffer()!);
                  for (const l of stillOffered) basket.remove(l.item);
                }
                // What is left is theirs; the line for THAT list is hidden,
                // and comes back when it changes.
                const remaining = basket.lines
                  .filter((l) => !offered.includes(l.item))
                  .map((l) => l.item)
                  .sort()
                  .join(',');
                if (remaining) hideList(remaining);
              }}
            />
          )}
          {state.kind === 'filling' && <FillingLine job={state.job} items={state.items} onStop={() => onStop(state.job.id)} />}
          {state.kind === 'ready' && <ReadyLine jobs={state.jobs} onOpen={() => setOpen(state.jobs[0].vendor)} onPay={setPaying} />}
          {state.kind === 'failed' && (
            <>
              <button onClick={() => setOpen(`${state.job.vendor}:failed`)} className="flex-1 min-w-0 text-left flex items-center gap-2.5">
                <X className="w-4 h-4 text-clay-500 shrink-0" />
                <span className="text-sm text-ink-700 truncate">{state.text}</span>
              </button>
              <CornerClose onClick={() => onDismiss(state.job.id)} />
            </>
          )}
        </div>
      </div>

      {open !== null && hasSheet && (
        <CartSheet
          tab={open}
          onTab={setOpen}
          basket={basket}
          vendor={cartVendor}
          vendors={cartVendors}
          onVendor={onCartVendor}
          jobs={readyJobs}
          failed={failedJobs}
          edited={edited}
          setEdited={setEdited}
          vendorChosen={vendorChosen}
          fallback={fallback}
          inventory={inventory}
          prefs={prefs}
          delivery={delivery}
          sending={sending}
          live={live}
          showToast={showToast}
          onSend={(vendor, lines) => {
            setOpen(null);
            onSend(vendor, lines);
          }}
          onPay={(job) => {
            setOpen(null);
            setPaying(job);
          }}
          onDismiss={onDismiss}
          onMoreItems={
            onMoreItems &&
            (() => {
              setOpen(null);
              onMoreItems();
            })
          }
          onClose={() => setOpen(null)}
        />
      )}

      {paying && payable(paying, PAY_ENABLED).toPay !== null && (
        <PayNow
          toPay={payable(paying, PAY_ENABLED).toPay!}
          cards={cardsFor(paying.vendor)}
          vendor={paying.vendor}
          cartJobId={paying.id}
          // Paid for: the cart leaves the line, so "Pay on Blinkit" is never
          // offered for a cart whose money has already moved. The api refuses
          // that too; this is the page not asking.
          onPaid={() => idsOf(paying).forEach(onDismiss)}
          onClose={() => setPaying(null)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------- the line ---

function PickingLine({
  lines,
  vendor,
  inventory,
  delivery,
  ready,
  sending,
  onOpen,
  onOpenReady,
  onSend,
  onHide,
}: {
  lines: BasketLine[];
  vendor: string;
  inventory: InventoryItem[];
  delivery?: { fee: number | null; freeAbove: number | null };
  ready: CartJobSummary[];
  sending: boolean;
  onOpen: () => void;
  onOpenReady: () => void;
  onSend: () => void;
  onHide: () => void;
}) {
  const est = estimateFor(lines, inventory);
  const topUp = useTopUp(lines, inventory, delivery);
  return (
    <>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left flex items-center gap-2.5">
        <ShoppingCart className="w-4 h-4 text-sage-700 shrink-0" />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink-800 truncate">
            {lines.length} {lines.length === 1 ? 'thing' : 'things'}
            {est.trustworthy ? ` · about ${money(est.total)}` : ''}
          </span>
          {/* One second line, the most useful one: carts with money waiting
              on them, else the free-delivery gap, else what is going. */}
          <span className="block text-2xs truncate">
            {ready.length ? (
              <button onClick={(e) => (e.stopPropagation(), onOpenReady())} className="text-sage-700 font-medium inline-flex items-center gap-0.5">
                {readyWords(ready)}
                <ChevronRight className="w-3 h-3" />
              </button>
            ) : topUp ? (
              <span className="text-clay-700">{money(topUp.gap)} short of free delivery</span>
            ) : (
              <span className="text-ink-500">{lines.map((l) => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name)).join(', ')}</span>
            )}
          </span>
        </span>
      </button>
      <button onClick={onSend} disabled={sending} className="btn-primary text-sm py-2 px-4 shrink-0">
        {sending ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : null}
        Send to {cartVendorInfo(vendor).name}
      </button>
      {/* Pushes the line away, not the list: what is on it stays on its rows,
          and the line is back the moment the list changes. On the corner
          rather than in the row - in the row it took the width the amount
          needed, and "about ₹1…" is not an amount. */}
      <CornerClose onClick={onHide} />
    </>
  );
}

// Filled carts waiting to be paid for or looked at. One cart: its app, its
// amount, and Pay on that app. Two: both amounts, and the sheet to choose.
function ReadyLine({ jobs, onOpen, onPay }: { jobs: CartJobSummary[]; onOpen: () => void; onPay: (job: CartJobSummary) => void }) {
  const one = jobs.length === 1 ? jobs[0] : null;
  const pay = one ? payable(one, PAY_ENABLED) : null;
  return (
    <>
      <button onClick={onOpen} className="flex-1 min-w-0 text-left flex items-center gap-2.5">
        <Check className="w-4 h-4 text-sage-600 shrink-0" />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink-800 truncate">{one ? readyWords(jobs) : `${jobs.length} carts ready`}</span>
          <span className="block text-2xs text-ink-500 truncate">
            {one ? readySubline(one) : jobs.map((j) => `${cartVendorInfo(j.vendor).name} ${amountOf(j) ?? ''}`.trim()).join(' · ')}
          </span>
        </span>
      </button>
      {one && pay?.canPay ? (
        <button onClick={() => onPay(one)} className="btn-primary text-sm py-2 px-4 shrink-0">
          Pay on {cartVendorInfo(one.vendor).name}
        </button>
      ) : (
        <button onClick={onOpen} className="btn-secondary text-sm py-2 px-3 shrink-0">
          See
        </button>
      )}
      {/* No x here. A ready cart is money waiting to be paid, and pushing
          the line away was the only way to lose the way to pay it: "If I
          close it, I can't get it back". A cart leaves the line through
          Done in the sheet, where what is being let go is in view. */}
    </>
  );
}

// While a cart is being filled: the app is tapped through item by item, so
// it is not instant, and the line says so.
function FillingLine({ job, items, onStop }: { job: CartJobSummary; items: number; onStop: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = cartSecondsLeft(items, job.at, now);
  return (
    <>
      <Loader2 className="w-4 h-4 text-sage-600 animate-spin-slow shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink-800 truncate">
          Filling your {cartVendorInfo(job.vendor).name} cart · {items} {items === 1 ? 'thing' : 'things'}
        </p>
        <p className="text-2xs text-ink-500 truncate">{timeLeftText(left)}. You can leave this page.</p>
      </div>
      {/* It cannot be killed outright - it is driving a real cart - so it
          stops after the item it is on, and what went in stays. */}
      <button onClick={onStop} className="text-xs font-medium text-ink-500 hover:text-ink-800 shrink-0 px-2 py-1 rounded-md hover:bg-sand-100">
        Stop
      </button>
    </>
  );
}

function CornerClose({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Hide this"
      className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-surface border border-sand-200 shadow-soft text-ink-400 hover:text-ink-700 flex items-center justify-center"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  );
}

const amountOf = (job: CartJobSummary): string | null => {
  const toPay = job.result?.bill?.toPay ?? null;
  return toPay === null ? null : `₹${Math.round(toPay)}`;
};

// "Blinkit cart ready · ₹138", or "2 carts ready".
function readyWords(jobs: CartJobSummary[]): string {
  if (jobs.length !== 1) return `${jobs.length} carts ready`;
  const amount = amountOf(jobs[0]);
  return `${cartVendorInfo(jobs[0].vendor).name} cart ready${amount ? ` · ${amount}` : ''}`;
}

// What is in the cart, by name. It said "1 in · 4 not there" once, which is
// a tally, not a cart; what was not there is the sheet's to explain.
function readySubline(job: CartJobSummary): string {
  // The race - the app's own cart replacing ours when opened - is Blinkit's,
  // whose cart lives in the browser that filled it. On an app whose cart is
  // the account's there is one cart and nothing to replace; the warning was
  // said for Instamart anyway, about a cart that was simply theirs.
  const race = cartVendorInfo(job.vendor).theirsToOpen ? null : cartRaceWarning(job);
  if (race) return race;
  const names = inCartFromCart(job).names;
  const said = names.join(', ');
  return job.result?.stopped ? `Stopped. ${said || 'Nothing went in'}` : said || 'Nothing went in';
}

// ------------------------------------------------------------- the sheet ---

// One tab per thing there is - and one per APP at most. An app's tab holds
// its filled cart, if there is one, and the things it could still add, if
// there are any; both when both. Two carts once spawned five tabs, each
// app's misses becoming a "+N" tab for the other, and the labels were down
// to "Inst…" and "Blin…".
type Tab =
  | { id: 'list' }
  | { id: string; job?: CartJobSummary; lines?: BasketLine[] }
  | { id: string; failed: CartJobSummary; text: string };

function CartSheet({
  tab,
  onTab,
  basket,
  vendor,
  vendors,
  onVendor,
  jobs,
  failed,
  inventory,
  prefs,
  delivery,
  sending,
  live,
  showToast,
  onSend,
  onPay,
  onDismiss,
  onMoreItems,
  onClose,
  edited,
  setEdited,
  vendorChosen,
  fallback,
}: {
  tab: string;
  onTab: (id: string) => void;
  basket: Basket;
  vendor: string;
  vendors: CartVendorInfo[];
  onVendor?: (id: string) => void;
  jobs: CartJobSummary[];
  failed: CartJobSummary[];
  inventory: InventoryItem[];
  prefs: ProductPref[];
  delivery?: { fee: number | null; freeAbove: number | null };
  sending: boolean;
  live: boolean;
  showToast: (toast: Omit<Toast, 'id'>) => void;
  onSend: (vendor: string, lines: BasketLine[]) => void;
  onPay: (job: CartJobSummary) => void;
  onDismiss: (jobId: string) => void;
  onMoreItems?: () => void;
  onClose: () => void;
  edited: Record<string, BasketLine[]>;
  setEdited: React.Dispatch<React.SetStateAction<Record<string, BasketLine[]>>>;
  vendorChosen: boolean;
  fallback: boolean;
}) {
  // What the stores would not sell, and where else the household buys it.
  // Only misses that no ready cart already holds - and an app that already
  // has a cart can still be offered the rest: "Eggs, Guava, Hair
  // conditioner" were called "not on any of your apps" once, purely because
  // Instamart's cart was already made. They were on Instamart.
  const { elsewhere, nowhere } = useMemo(() => {
    const inSomeCart = new Set(jobs.flatMap((j) => (j.result?.lines ?? []).filter((l) => l.inCart > 0).map((l) => l.item)));
    const misses = jobs.flatMap((j) => (j.result?.lines ?? []).filter((l) => l.inCart === 0 && !inSomeCart.has(l.item)));
    const unique = misses.filter((l, i) => misses.findIndex((m) => m.item === l.item) === i);
    // Grouped per app, by which app each thing was missed at: what Blinkit
    // did not have goes to the other apps, and the other way round.
    const groups = new Map<string, BasketLine[]>();
    const none: string[] = [];
    for (const j of jobs) {
      const here = unique.filter((l) => (j.result?.lines ?? []).some((m) => m.item === l.item && m.inCart === 0));
      const found = elsewhereFor(here, inventory, prefs, vendors.map((v) => v.id), j.vendor);
      for (const g of found.elsewhere) groups.set(g.vendor, [...(groups.get(g.vendor) ?? []), ...g.lines.filter((l) => !(groups.get(g.vendor) ?? []).some((x) => x.item === l.item))]);
      for (const n of found.nowhere) if (!none.includes(n)) none.push(n);
    }
    // A thing another app has is not "nowhere", whichever cart missed it.
    const placed = new Set([...groups.values()].flat().map((l) => l.name));
    return { elsewhere: [...groups.entries()].map(([vendor, lines]) => ({ vendor, lines })), nowhere: none.filter((n) => !placed.has(n)) };
  }, [jobs, inventory, prefs, vendors]);

  // The things the other app has, as the household has edited them: they
  // can take one off or ask for two before sending, the same as on the
  // list. Starts from what the orders say and follows the taps.
  const linesFor = (v: string): BasketLine[] => edited[v] ?? elsewhere.find((g) => g.vendor === v)?.lines ?? [];
  const editLines = (v: string, fn: (lines: BasketLine[]) => BasketLine[]) => setEdited((e) => ({ ...e, [v]: fn(linesFor(v)) }));
  const vendorOf = (id: string) => id.replace(/:failed$/, '');

  // One tab per app: its cart, and what it could still add, merged.
  const perVendor = new Map<string, { job?: CartJobSummary; lines?: BasketLine[] }>();
  for (const job of jobs) perVendor.set(job.vendor, { job });
  // The other app's things are offered only while the household wants them
  // offered - the switch on the Grocery apps page.
  if (fallback) {
    for (const g of elsewhere) {
      const lines = linesFor(g.vendor);
      if (lines.length) perVendor.set(g.vendor, { ...perVendor.get(g.vendor), lines });
    }
  }
  const tabs: Tab[] = [
    ...(basket.lines.length ? [{ id: 'list' } as Tab] : []),
    ...[...perVendor.entries()].map(([id, t]): Tab => ({ id, ...t })),
    ...failed.map((f): Tab => ({ id: `${f.vendor}:failed`, failed: f, text: CART_ERROR_TEXT[f.errorCode ?? ''] ?? CART_ERROR_FALLBACK })),
  ];
  // The tab that was open is the one shown - never the next one along. When
  // it empties and goes, the sheet closes with it: falling through to the
  // Blinkit cart after the list emptied put a bin under a finger that had
  // just pressed one, and the third press emptied the cart.
  const shown = tabs.find((t) => t.id === tab);
  useEffect(() => {
    if (!shown) onClose();
  }, [shown, onClose]);
  if (!shown) return null;
  // Pulled out once, so the callbacks below see a cart and a list that are
  // definitely there - TypeScript will not carry a narrowing into a closure.
  const cartJob = 'job' in shown && shown.job ? shown.job : null;
  const cartLines = 'lines' in shown && shown.lines ? shown.lines : null;
  const cartVendorId = vendorOf(shown.id);

  return (
    <Sheet title={tabs.length > 1 ? 'Your cart' : shown.id === 'list' ? 'Your list' : `Your ${cartVendorInfo(shown.id).name} cart`} onClose={onClose}>
      {tabs.length > 1 && (
        <div className="flex gap-2 mb-4">
          {tabs.map((t) => {
            const on = t.id === shown.id;
            return (
              <button
                key={t.id}
                onClick={() => onTab(t.id)}
                aria-pressed={on}
                className={`flex-1 min-w-0 rounded-xl border px-3 py-2 text-left transition-colors ${
                  on ? 'bg-ink-800 border-ink-800 text-sand-50' : 'bg-surface border-sand-200 text-ink-700 hover:border-sand-300'
                }`}
              >
                <span className="block text-sm font-semibold truncate">{t.id === 'list' ? 'Your list' : cartVendorInfo(vendorOf(t.id)).name}</span>
                <span className={`block text-2xs truncate ${on ? 'text-sand-200' : 'text-ink-400'}`}>
                  {'failed' in t
                    ? 'did not work'
                    : t.id === 'list'
                      ? `${basket.lines.length} to send`
                      : [
                          'job' in t && t.job ? `${inCartFromCart(t.job).count} in${amountOf(t.job) ? ` · ${amountOf(t.job)}` : ''}` : null,
                          // Beside a cart there is no room for words: "+4".
                          'lines' in t && t.lines ? ('job' in t && t.job ? `+${t.lines.length}` : `${t.lines.length} to send`) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Above the list rather than under the buttons: the buttons sit at
          the foot of the sheet now, and nothing may sit below them. */}
      {nowhere.length > 0 && shown.id !== 'list' && (
        <p className="text-xs text-ink-500 mb-3">
          Not on any of your apps right now: <span className="text-ink-700">{nowhere.join(', ')}</span>
        </p>
      )}

      {shown.id === 'list' && (
        <ListTab
          basket={basket}
          vendor={vendor}
          vendors={vendors}
          vendorChosen={vendorChosen}
          inventory={inventory}
          delivery={delivery}
          sending={sending}
          live={live}
          showToast={showToast}
          onSend={(v) => {
            // The app tapped becomes the usual one, so the line's button
            // says the same thing next time.
            onVendor?.(v);
            onSend(v, basket.lines);
          }}
          onMoreItems={onMoreItems}
          onClose={onClose}
        />
      )}

      {cartJob && (
        <CartTab
          job={cartJob}
          // What this app could still add, from the other cart's misses:
          // shown under its own cart rather than as a tab of its own.
          extra={
            cartLines
              ? {
                  lines: cartLines,
                  onEdit: (lines) => setEdited((e) => ({ ...e, [cartVendorId]: lines })),
                  onSend: () => onSend(cartVendorId, cartLines),
                }
              : undefined
          }
          inventory={inventory}
          edited={edited[`cart:${cartJob.id}`] ?? null}
          onEdit={(lines) => setEdited((e) => ({ ...e, [`cart:${cartJob.id}`]: lines }))}
          // Sent again with the edits; the cart that comes back is the one to
          // pay for, and this one leaves the line.
          onUpdate={(lines) => {
            for (const id of idsOf(cartJob)) onDismiss(id);
            onSend(cartJob.vendor, lines);
          }}
          onPay={() => onPay(cartJob)}
          onDone={() => {
            for (const id of idsOf(cartJob)) onDismiss(id);
            if (tabs.length <= 1) onClose();
          }}
          sending={sending}
        />
      )}

      {cartLines && !cartJob && (
        <>
          <p className="text-xs text-ink-500">
            Not at {jobs.filter((j) => j.vendor !== cartVendorId).map((j) => cartVendorInfo(j.vendor).name).join(' or ')} today.{' '}
            {cartVendorInfo(cartVendorId).name} has these:
          </p>
          <div className="divide-y divide-sand-100 mt-1">
            {cartLines.map((l) => (
              <Line
                key={l.item}
                line={l}
                inventory={inventory}
                onQty={(q) => editLines(cartVendorId, (ls) => ls.map((x) => (x.item === l.item ? { ...x, qty: q } : x)))}
                onRemove={() => editLines(cartVendorId, (ls) => ls.filter((x) => x.item !== l.item))}
              />
            ))}
          </div>
          <Foot>
            <button onClick={() => onSend(cartVendorId, cartLines)} disabled={sending} className="btn-primary text-sm py-2.5 px-4">
              <ShoppingCart className="w-4 h-4" />
              Send {cartLines.length} to {cartVendorInfo(cartVendorId).name}
            </button>
          </Foot>
        </>
      )}

      {'failed' in shown && (
        <>
          <p className="text-sm text-clay-600">{shown.text}</p>
          <button
            onClick={() => {
              onDismiss(shown.failed.id);
              if (tabs.length <= 1) onClose();
            }}
            className="btn-ghost text-sm mt-4"
          >
            Done
          </button>
        </>
      )}

    </Sheet>
  );
}

// The list being made: what is going, how many of each, roughly what it
// costs, where, and the one thing that would make delivery free.
function ListTab({
  basket,
  vendor,
  vendors,
  vendorChosen = false,
  inventory,
  delivery,
  sending,
  live,
  showToast,
  onSend,
  onMoreItems,
  onClose,
}: {
  basket: Basket;
  vendor: string;
  vendors: CartVendorInfo[];
  // Chosen on the Grocery apps page: then only that app's Send is offered.
  vendorChosen?: boolean;
  inventory: InventoryItem[];
  delivery?: { fee: number | null; freeAbove: number | null };
  sending: boolean;
  live: boolean;
  showToast: (toast: Omit<Toast, 'id'>) => void;
  // Send the list to this app. Which app is chosen on the button itself.
  onSend: (vendor: string) => void;
  onMoreItems?: () => void;
  onClose: () => void;
}) {
  const est = estimateFor(basket.lines, inventory);
  const topUp = useTopUp(basket.lines, inventory, delivery);
  const addOne = (id: string) => {
    const item = inventory.find((i) => i.id === id);
    const product = item?.products?.[0];
    if (!item || !product) return;
    if (!live) {
      showToast({ message: 'Sample data. Sign in to fill your own cart.', type: 'info' });
      return;
    }
    basket.add({ item: item.id, name: item.name, emoji: item.emoji, product: product.name, pack: product.pack ?? '', qty: product.usualCount || 1 });
  };
  // Where it can go: every app a cart can go to that this household has
  // connected, the usual one first. Chosen on the button itself - a row of
  // app chips above the list read as a second set of tabs.
  const choices = Object.values(CART_VENDOR_INFO)
    .filter((v) => vendors.some((c) => c.id === v.id))
    // An app chosen on the Grocery apps page is the only one offered here;
    // the other is reached through what the chosen one lacks.
    .filter((v) => !vendorChosen || v.id === vendor)
    .sort((a, b) => Number(b.id === vendor) - Number(a.id === vendor));
  return (
    <>
      <div className="divide-y divide-sand-100">
        {basket.lines.map((l) => (
          <Line key={l.item} line={l} inventory={inventory} onQty={(q) => basket.setQty(l.item, q)} onRemove={() => basket.remove(l.item)} />
        ))}
      </div>

      {/* The bill as far as it can be known before the store says. Items from
          what they last paid; delivery from what this store charged last time.
          Nothing invented: no price known, no figure shown. */}
      <div className="mt-4 pt-3 border-t border-sand-100 space-y-1">
        {est.trustworthy && (
          <p className="flex justify-between text-xs text-ink-500">
            <span>Items, about</span>
            <span className="tabular-nums">{money(est.total)}</span>
          </p>
        )}
        {delivery?.fee !== null && delivery?.fee !== undefined && (
          <p className="flex justify-between text-xs text-ink-500">
            <span>Delivery{topUp ? '' : delivery.freeAbove && est.total >= delivery.freeAbove ? ', free above ' + money(delivery.freeAbove) : ''}</span>
            <span className="tabular-nums">{topUp || !delivery.freeAbove || est.total < delivery.freeAbove ? money(delivery.fee) : 'Free'}</span>
          </p>
        )}
        {!est.trustworthy && <p className="text-2xs text-ink-400">Prices are not known for enough of these to add up.</p>}
      </div>

      {/* The nudge, where the fee is. Only when it is true, and only things
          this household buys on a rhythm of their own and that cost less
          than the fee they save (lib/topup.ts). One tap adds. */}
      {topUp && (
        <div className="mt-3 rounded-xl bg-sage-50 border border-sage-200 p-3">
          <p className="text-sm text-ink-800">
            <span className="font-semibold">{money(topUp.gap)} more</span> and delivery is free
            <span className="text-ink-500"> (saves {money(topUp.saves)})</span>
          </p>
          {topUp.picks.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {topUp.picks.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addOne(p.id)}
                  className="flex items-center gap-1.5 text-xs py-1.5 px-3 rounded-full border border-sage-200 bg-surface hover:bg-sage-100 text-ink-700"
                >
                  <span aria-hidden>{p.emoji}</span>
                  {p.name}
                  <span className="text-ink-400 tabular-nums">{money(p.price)}</span>
                  <Plus className="w-3.5 h-3.5 text-sage-700" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {onMoreItems && (
        <button onClick={onMoreItems} className="mt-3 text-xs font-medium text-sage-700 inline-flex items-center gap-0.5">
          More things to add
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}

      <Foot>
        {choices.map((v) => (
          <button
            key={v.id}
            onClick={() => onSend(v.id)}
            disabled={sending || !basket.lines.length}
            className={`${v.id === vendor ? 'btn-primary' : 'btn-secondary'} text-sm py-2.5 px-4`}
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <ShoppingCart className="w-4 h-4" />}
            Send {basket.lines.length} to {v.name}
          </button>
        ))}
        {/* Home makes this list up without being asked, so there has to be a
            way to say no to the whole of it - and WHICH list was turned down
            is what is remembered, not the part of it still ticked. */}
        <button
          onClick={() => {
            declineBasket(lastOffer() ?? basket.lines.map((l) => l.item).sort().join(','));
            basket.clear();
            onClose();
          }}
          disabled={sending}
          className="btn-ghost text-sm"
        >
          Clear
        </button>
      </Foot>
    </>
  );
}

// One thing on a list, set out like a receipt line: what it is, then how
// many and what that comes to. The price is what they last paid for it, and
// the line's figure is that times the count - so changing the count changes
// the figure, which is how somebody decides between one packet and two.
function Line({
  line,
  inventory,
  priceEach,
  onQty,
  onRemove,
}: {
  line: BasketLine;
  inventory: InventoryItem[];
  // The store's own price for this line, when it has said one. Without it
  // the row falls back to what the household last paid - which on a filled
  // cart showed Rs 109 for paneer the store was charging Rs 130 for.
  priceEach?: number | null;
  onQty: (q: number) => void;
  onRemove: () => void;
}) {
  const item = inventory.find((i) => i.id === line.item);
  const price = priceEach ?? (item ? lastPrice(item) : null);
  return (
    <div className="py-2.5">
      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0 w-7 text-center leading-7">{line.emoji}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink-800 truncate">{line.name}</p>
          <p className="text-2xs text-ink-400 truncate">
            {line.product}
            {line.pack ? ` · ${line.pack}` : ''}
          </p>
        </div>
        <span className="text-sm text-ink-800 tabular-nums shrink-0 leading-7">{price !== null ? money(price * line.qty) : <span className="text-ink-300">no price</span>}</span>
      </div>
      <div className="flex items-center justify-between gap-3 pl-10 mt-1.5">
        <span className="text-2xs text-ink-400 tabular-nums">{price !== null && line.qty > 1 ? `${money(price)} each` : ''}</span>
        <div className="flex items-center gap-3">
          <button onClick={onRemove} aria-label={`Remove ${line.name}`} className="p-1.5 text-ink-300 hover:text-clay-600 shrink-0">
            <Trash2 className="w-4 h-4" />
          </button>
          <div className="w-28 shrink-0">
            {/* Minus at one takes it off: a stepper that stops at one is a
                stepper with a dead button on it. */}
            <Stepper label="" value={line.qty} onChange={(q) => (q <= 0 ? onRemove() : onQty(q))} min={0} max={20} />
          </div>
        </div>
      </div>
    </div>
  );
}

// One app's cart: what went in, its bill, and Pay on that app.
//
// With + and -, because a cart with a thing in it you no longer want is not a
// cart you can pay for. What is here is what the store's own cart holds, so a
// change cannot simply be written to it: the edited list is sent again, and
// the cart that comes back is the one to pay for. Until then the button says
// "Update", never "Pay" - paying the old cart after taking something off it
// is exactly the mistake this is here to prevent.
function CartTab({
  job,
  inventory,
  edited,
  onEdit,
  onUpdate,
  onPay,
  onDone,
  sending,
  extra,
}: {
  job: CartJobSummary;
  inventory: InventoryItem[];
  // Things this app could still add - what the OTHER app's cart did not
  // have and this one sells - with + and - and their own Send. Under the
  // cart rather than as a tab of their own, so there is one tab per app.
  extra?: { lines: BasketLine[]; onEdit: (lines: BasketLine[]) => void; onSend: () => void };
  // The cart as the household has edited it here, or null for as it stands.
  edited: BasketLine[] | null;
  onEdit: (lines: BasketLine[]) => void;
  onUpdate: (lines: BasketLine[]) => void;
  onPay: () => void;
  onDone: () => void;
  sending: boolean;
}) {
  const result = job.result?.lines ?? [];
  const went = result.filter((l) => (l.state === 'added' || l.state === 'already_there' || l.state === 'removed') && l.inCart > 0);
  // The cart's rows as things that can be stepped: what the store put in,
  // named the way the household knows them.
  const asIs: BasketLine[] = went.map((l) => {
    const item = inventory.find((i) => i.id === l.item);
    return { item: l.item, name: item?.name ?? l.product, emoji: item?.emoji ?? '🛒', product: l.product, pack: l.pack, qty: l.inCart };
  });
  const rows = edited ?? asIs;
  // What the store charges for each, from its own cart - never our guess.
  const priceOf = new Map(went.map((l) => [l.item, l.price]));
  // What the store would not sell, in its own words: "packs here: 1 ltr"
  // is the difference between "Instamart has no milk" and "not in the pack
  // you buy", and the household could not tell which they were looking at.
  const missed = result.filter((l) => l.inCart === 0);
  const changed = edited !== null && (edited.length !== asIs.length || edited.some((e) => asIs.find((a) => a.item === e.item)?.qty !== e.qty));
  // The last row taken off is the cart taken off. There is nothing to update
  // and nothing to pay for, so the cart simply goes - the sheet moves to the
  // next tab, or closes. A screen saying "everything taken off" with a
  // button to confirm it was a step nobody needed.
  useEffect(() => {
    if (changed && rows.length === 0) onDone();
  }, [changed, rows.length, onDone]);
  const vendor = cartVendorInfo(job.vendor);
  const { toPay, canPay } = payable(job, PAY_ENABLED);
  // Said before they tap, not after the api refuses: while paying is being
  // tested there is a ceiling on what one order may come to.
  const overCap = canPay && toPay !== null && toPay > ORDER_MAX_RUPEES;
  return (
    <>
      <div className="divide-y divide-sand-100">
        {rows.map((l) => (
          <Line
            key={l.item}
            line={l}
            inventory={inventory}
            priceEach={priceOf.get(l.item) ?? null}
            onQty={(q) => onEdit(rows.map((x) => (x.item === l.item ? { ...x, qty: q } : x)))}
            onRemove={() => onEdit(rows.filter((x) => x.item !== l.item))}
          />
        ))}
        {!rows.length && <p className="text-sm text-ink-500 py-2">Nothing went in.</p>}
      </div>
      {extra && !changed && (
        <div className="mt-4 pt-3 border-t border-sand-100">
          <p className="text-2xs font-semibold text-ink-500 uppercase tracking-wide">{vendor.name} also has these</p>
          <div className="divide-y divide-sand-100 mt-1">
            {extra.lines.map((l) => (
              <Line
                key={l.item}
                line={l}
                inventory={inventory}
                onQty={(q) => extra.onEdit(extra.lines.map((x) => (x.item === l.item ? { ...x, qty: q } : x)))}
                onRemove={() => extra.onEdit(extra.lines.filter((x) => x.item !== l.item))}
              />
            ))}
          </div>
          <button onClick={extra.onSend} disabled={sending} className="btn-secondary text-sm py-2 px-4 mt-3">
            <ShoppingCart className="w-4 h-4" />
            Send {extra.lines.length} more to {vendor.name}
          </button>
        </div>
      )}
      {/* What the store would not put in, and why, in its own words. Left
          unsaid, milk going to the other app's tab looked like a mistake
          when the store had simply not got the pack the household buys. */}
      {!changed && missed.length > 0 && (
        <div className="mt-3 rounded-xl bg-sand-100 px-3 py-2">
          <p className="text-2xs font-semibold text-ink-500 uppercase tracking-wide">Not added at {vendor.name}</p>
          {missed.map((l) => (
            <p key={l.item} className="text-xs text-ink-600 mt-0.5">
              <span className="text-ink-800">{inventory.find((i) => i.id === l.item)?.name ?? l.item}</span>
              {' · '}
              {l.state === 'out_of_stock' ? 'out of stock' : l.note ? l.note : 'not sold here'}
            </p>
          ))}
        </div>
      )}
      {/* The store's cart is the household's own, and it may already have
          held things they put there themselves. The bill below covers those
          too - a bill of Rs 942 under one Rs 260 line was read as a wrong
          price until this said why. */}
      {!changed && (job.result?.theirsBefore ?? 0) > 0 && <AlreadyInCart job={job} ours={went.map((l) => l.product)} vendorName={vendor.name} />}
      {changed && rows.length > 0 && (
        <p className="text-xs text-clay-700 mt-3">
          The {vendor.name} cart still holds what it did. Update it, and the new cart is the one to pay for.
        </p>
      )}
      {/* The bill, the delivery time and the address are the STORE's, about
          the cart as it stands. Once a row has changed they describe a cart
          that is about to be replaced, so they are not said. */}
      {!changed && job.result?.bill && <BillRows bill={job.result.bill} />}
      {!changed && job.result?.eta && <p className="text-xs text-ink-400 mt-0.5">Delivery in about {job.result.eta}.</p>}
      {/* "In your cart" is only true of an app whose cart the household can
          open. A Blinkit cart is the worker's own and they will never see it,
          so that sentence sent them to look at an empty cart. */}
      {!changed && job.result?.address && (
        <p className="text-xs text-ink-400 mt-0.5">
          {vendor.theirsToOpen ? `In your ${job.result.address} cart.` : `For ${job.result.address}. Filled here, not in the ${vendor.name} app.`}
        </p>
      )}
      {!changed && job.result?.message && <p className="text-xs text-ink-500 mt-2">{job.result.message}</p>}
      {toPay !== null && toPay > 0 && !vendor.canPay && <p className="text-xs text-ink-500 mt-2">Paying on {vendor.name} from here is not ready yet.</p>}
      {overCap && (
        <p className="text-xs text-ink-500 mt-3">
          Paying from here is capped at ₹{ORDER_MAX_RUPEES} while it is being tested.
          {vendor.theirsToOpen ? ` Pay this one in ${vendor.name}.` : ' This cart cannot be paid for anywhere else, so send a smaller one.'}
        </p>
      )}
      <Foot>
        {changed ? (
          <>
            <button onClick={() => onUpdate(rows)} disabled={sending} className="btn-primary text-sm py-2.5 px-4">
              {sending ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <ShoppingCart className="w-4 h-4" />}
              Update {vendor.name} cart
            </button>
            <button onClick={() => onEdit(asIs)} className="btn-ghost text-sm">
              Undo
            </button>
          </>
        ) : (
          <>
            {canPay && !overCap && (
              <button onClick={onPay} className="btn-primary text-sm py-2.5 px-4">
                Pay on {vendor.name} · ₹{Math.round(toPay!)}
              </button>
            )}
            {vendor.theirsToOpen && vendor.url && (
              <a href={vendor.url} target="_blank" rel="noreferrer" className={`${canPay ? 'btn-secondary' : 'btn-primary'} text-sm py-2.5 px-4`}>
                Open {vendor.name}
              </a>
            )}
            {/* Done is the dismissal: this cart leaves the line. Pushing it
                away is a decision about THIS cart, remembered by id, so
                tomorrow's is a new notice (lib/seen.ts). */}
            <button onClick={onDone} className="btn-ghost text-sm">
              Done
            </button>
          </>
        )}
      </Foot>
    </>
  );
}

// The buttons of a tab, kept in view while its list scrolls under them. The
// household had to scroll a long list to find Send; the thing to press is
// the one thing that must never be out of reach.
function Foot({ children }: { children: React.ReactNode }) {
  // `mt-auto` for a short list, `sticky` for a long one: at the foot either way.
  return <div className="sticky bottom-0 mt-auto -mx-6 px-6 pt-3 pb-1 sheet-surface border-t border-sand-100 flex flex-wrap gap-2 shrink-0">{children}</div>;
}

// What was in the store's cart before this job put anything in - the things
// the household added themselves, in the app. Set apart and named, because
// the bill covers them too: a bill of Rs 942 under one Rs 260 line read as a
// wrong price until this said what the other Rs 680 was. Older carts hold
// only a count, and then only the count is said.
function AlreadyInCart({ job, ours, vendorName }: { job: CartJobSummary; ours: string[]; vendorName: string }) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const mine = new Set(ours.map(norm));
  const theirs = (job.result?.cart ?? []).filter((l) => !mine.has(norm(l.name)));
  const count = job.result?.theirsBefore ?? theirs.length;
  return (
    <div className="mt-4 pt-3 border-t border-sand-100">
      <p className="text-2xs font-semibold text-ink-500 uppercase tracking-wide">Already in your {vendorName} cart</p>
      {theirs.length ? (
        <div className="divide-y divide-sand-100 mt-1">
          {theirs.map((l, i) => (
            <div key={`${l.name}-${i}`} className="flex items-start gap-3 py-1.5">
              <span className="shrink-0 mt-0.5 min-w-[1.75rem] text-center text-xs font-semibold tabular-nums rounded-md px-1.5 py-1 bg-sand-100 text-ink-600">{l.quantity}</span>
              <p className="text-sm text-ink-700 min-w-0 truncate">{l.name}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-600 mt-1">
          {count} {count === 1 ? 'thing' : 'things'} you added in the app.
        </p>
      )}
      <p className="text-2xs text-ink-400 mt-1.5">The bill below includes {(theirs.length || count) === 1 ? 'it' : 'them'}.</p>
    </div>
  );
}

// The bill as the vendor's cart gives it. Broken out rather than written as a
// sentence, because this is the number the household is about to agree to and
// the fees are the part that surprises (design §19 stage 2).
function BillRows({ bill }: { bill: CartBill }) {
  if (bill.toPay === null) return null;
  const rows: [string, number | null][] = [
    ['Items', bill.itemTotal],
    ['Delivery', bill.delivery],
    ['Surge fee', bill.surge],
    ['Small cart fee', bill.smallCart],
    ['Other charges', bill.other ?? null],
  ];
  return (
    <div className="mt-3 pt-3 border-t border-sand-100 space-y-1">
      {rows.map(([label, amount]) =>
        amount ? (
          <p key={label} className="flex justify-between text-xs text-ink-500">
            <span>{label}</span>
            <span className="tabular-nums">₹{Math.round(amount)}</span>
          </p>
        ) : null,
      )}
      <p className="flex justify-between text-sm font-semibold text-ink-800 pt-1">
        <span>To pay</span>
        <span className="tabular-nums">₹{Math.round(bill.toPay)}</span>
      </p>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 bg-scrim/30 backdrop-blur-sm z-40 animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // One height whatever is in it, so a sheet with one row and a sheet
        // with four are the same sheet: the list scrolls inside, the header
        // and the buttons stay where they are. It grew with the list before,
        // and a sheet that changes size as things are taken off looks broken.
        className="fixed bottom-0 left-0 right-0 md:top-1/2 md:left-1/2 md:bottom-auto md:translate-x-[-50%] md:translate-y-[-50%] md:w-[440px] z-50 sheet-surface rounded-t-3xl md:rounded-3xl shadow-soft-lg h-[72vh] md:h-[600px] overflow-hidden flex flex-col animate-slide-up md:animate-scale-in"
      >
        <div className="md:hidden flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1.5 rounded-full bg-sand-300" />
        </div>
        <div className="p-6 pt-0 flex-1 min-h-0 overflow-y-auto scroll-area flex flex-col">
          {/* Stays put while the list scrolls under it, so the way out is
              never scrolled away: a long list had no visible close. */}
          <div className="sticky top-0 z-10 -mx-6 px-6 pt-3 pb-3 mb-3 sheet-surface flex items-center justify-between gap-3">
            <h2 className="font-display text-xl text-ink-900 min-w-0 truncate">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-sand-100 text-ink-400">
              <X className="w-5 h-5" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}

// "₹12 more and delivery is free", from what is on the list and what this
// store charged last time - and only suggesting things the household buys
// on a rhythm of their own (lib/topup.ts).
function useTopUp(lines: BasketLine[], inventory: InventoryItem[], delivery?: { fee: number | null; freeAbove: number | null }) {
  return useMemo(() => {
    const subtotal = estimateFor(lines, inventory).total;
    return topUpForFreeDelivery({
      subtotal,
      threshold: delivery?.freeAbove,
      deliveryFee: delivery?.fee,
      candidates: inventory
        .filter((i) => !lines.some((l) => l.item === i.id) && i.usualGapDays)
        .map((i) => ({ id: i.id, name: i.name, emoji: i.emoji, price: lastPrice(i) ?? 0, dueRatio: i.dueRatio }))
        .filter((c) => c.price > 0),
    });
  }, [lines, inventory, delivery?.freeAbove, delivery?.fee]);
}

const money = (n: number) => (n >= 1000 ? `₹${(n / 1000).toFixed(1)}k` : `₹${Math.round(n)}`);
