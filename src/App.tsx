import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { LANDING_VIEW, MAIN_VIEWS } from './types';
import type {
  AppStage,
  MainView,
  SourceId,
  Source,
  InventoryItem,
  ShoppingListItem,
  Toast,
} from './types';
import { SOURCES, SAMPLE_INVENTORY, SAMPLE_SHOPPING_LIST, SAMPLE_PURCHASE_HISTORY, SAMPLE_INSIGHT } from './data';

import { fetchMe, fetchSession, signInOutcome, signOut, type Me, type Session } from '@/lib/auth';
import { chooseCartAddress, fetchConnections, setDefaultCartVendor, type Connection, setCartFallback as setCartFallbackApi } from '@/lib/connect';
import { CONNECTABLE_SOURCES, HISTORY_DEFAULT_RANGE_DAYS, HOUSEHOLD_REFRESH_SKUS, INSIGHTS_DEFAULT_RANGE_DAYS, RANGE_STORAGE_KEYS } from '@/lib/constants';
import { useRememberedRange } from '@/lib/ranges';
import { retryImport } from '@/lib/imports';
import { useHousehold } from '@/lib/useHousehold';
import { useImports } from '@/lib/useImports';
import { vendorRows, type VendorRow } from '@/lib/vendors';

import { Welcome } from './components/onboarding/Welcome';
import { SignIn } from './components/onboarding/SignIn';
import { LiveConnect } from './components/onboarding/LiveConnect';
import { Connect } from './components/onboarding/Connect';
import { Join } from './components/onboarding/Join';
import { Auth } from './components/onboarding/Auth';
import { Importing } from './components/onboarding/Importing';
import { LiveImporting } from './components/onboarding/LiveImporting';
import { Learned } from './components/onboarding/Learned';

import { AskCards } from './components/AskCards';
import { Bell } from './components/Bell';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { HouseholdQuick } from './components/HouseholdQuick';
import { TellUs } from './components/TellUs';
import { ImportBar } from './components/ImportBar';
import { ProfileMenu } from './components/ProfileMenu';
import { Sidebar } from './components/Sidebar';
import { ToastStack } from './components/Toast';
import { CartDock } from './components/CartDock';
import { setBillingDay } from './lib/insights';
import { LiveOrderBar, PayNow } from '@/components/PayNow';
import { useBasket } from './lib/basket';
import { cancelCart, deliveryTerms } from './lib/cart';
import { readSeen, useSeen } from './lib/seen';
import type { BasketLine } from './lib/basket';
import { dismissWith } from './lib/dock';
import { rankProducts } from './lib/products';
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme';
import { lastOffer, rememberSent } from './lib/basket';
import { useCartJobs } from './lib/useCartJobs';
import { useLiveOrder } from './lib/useLiveOrder';
import { CART_VENDOR, CART_VENDOR_INFO, SEEN_CART_KEY } from './lib/constants';
import { InventoryView } from './components/views/InventoryView';
import { HistoryView } from './components/views/HistoryView';
import { AppsView } from './components/views/AppsView';
import { CookView } from './components/views/CookView';
import { HouseholdView } from './components/views/HouseholdView';
import { AiSettingsView } from './components/views/AiSettingsView';
import { HowItWorksView } from './components/views/HowItWorksView';
import { InsightsView } from './components/views/InsightsView';
import { MealPlanView } from './components/views/MealPlanView';

// Which page the address bar is pointing at. Anything unrecognised is home,
// so a stale or hand-typed link never lands nowhere.
function viewInUrl(): MainView | null {
  try {
    const name = window.location.hash.replace(/^#/, '');
    // A link from before the Home tab was folded away still works.
    if (name === 'home') return LANDING_VIEW;
    return (MAIN_VIEWS as string[]).includes(name) ? (name as MainView) : null;
  } catch {
    return null;
  }
}

function App() {
  const [stage, setStage] = useState<AppStage>('welcome');
  // The page is in the address bar, so a reload comes back to it and the
  // phone's Back button steps between pages rather than leaving the app.
  const [view, setView] = useState<MainView>(() => viewInUrl() ?? LANDING_VIEW);
  useEffect(() => {
    if (viewInUrl() === view) return;
    try {
      window.history.replaceState(null, '', view === LANDING_VIEW ? window.location.pathname : `#${view}`);
    } catch {
      // Some browsers refuse this in odd contexts; the page still works, it
      // just forgets where it was on a reload.
    }
  }, [view]);
  // The Back button, which on a phone is the one people actually use.
  useEffect(() => {
    const onPop = () => setView(viewInUrl() ?? LANDING_VIEW);
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);
  // The window each page is read over (design §12.7), remembered per person in
  // this browser. Insights opens on a year because that is the widest window
  // where two apps with different histories can be compared; purchase history
  // opens on three months, which holds a slow staple's rhythm.
  const [insightsRange, setInsightsRange] = useRememberedRange(RANGE_STORAGE_KEYS.insights, INSIGHTS_DEFAULT_RANGE_DAYS);
  const [historyRange, setHistoryRange] = useRememberedRange(RANGE_STORAGE_KEYS.history, HISTORY_DEFAULT_RANGE_DAYS);
  const [sources, setSources] = useState<Source[]>(SOURCES);
  const [connectedSourceIds, setConnectedSourceIds] = useState<SourceId[]>([]);
  const [currentAuthSource, setCurrentAuthSource] = useState<SourceId | null>(null);
  const [authIndex, setAuthIndex] = useState(0);

  // The cart list and the carts being filled (design §19 stage 1).
  const basket = useBasket();
  const [sending, setSending] = useState(false);
  // Which connected app a cart is sent to. Only ever asked when the household
  // has more than one that can take one; with a single app there is nothing
  // to choose and no control is shown.
  const [cartVendor, setCartVendorState] = useState<string>(CART_VENDOR);
  // The full review of what could be sent, on Supplies. Opened from the cart
  // line at the bottom, so it is App's to hold.
  const [reviewing, setReviewing] = useState(false);
  // The finished cart the household pushed away, by id. Through useSeen so
  // it survives a reload - it was plain state once and came back on every
  // load until it did not (lib/seen.ts). One flag now, because there is one
  // place the cart is shown; there were two, and saying "yes I saw it" to
  // one of them took away the only way to pay.
  const [seenCart, forgetCart] = useSeen(SEEN_CART_KEY);
  const [inventory, setInventory] = useState<InventoryItem[]>(SAMPLE_INVENTORY);
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>(SAMPLE_SHOPPING_LIST);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // The phone's own light/dark setting can change while the app is open
  // (sunset, a schedule); "Auto" has to follow it.
  useEffect(() => watchSystemTheme(() => applyTheme(readTheme())), []);

  // Sign-in (design §14.3): the api holds the session; we only ask about it.
  const [session, setSession] = useState<Session | null>(null);
  // True until we know where a returning visitor belongs. Coming back from
  // Google, the welcome page would otherwise show for a few seconds and look
  // like the sign-in did nothing.
  const [checking, setChecking] = useState(true);
  const [signInResult, setSignInResult] = useState(() => signInOutcome(window.location.search));
  const [me, setMe] = useState<Me | null>(null);
  // The household's saved choice, once we know who they are. Without this the
  // choice lived in this component and a reload sent the next cart to the
  // default again - the same mistake as a dismissed notice coming back.
  useEffect(() => {
    const saved = me?.household?.cartVendor;
    if (saved && CART_VENDOR_INFO[saved]) setCartVendorState(saved);
  }, [me?.household?.cartVendor]);
  // Whether the cart sheet offers, from the other app, what the usual one
  // does not have. On unless the household has turned it off; the switch is
  // on the Grocery apps page, beside the choice of usual app.
  const [cartFallback, setCartFallbackState] = useState(true);
  useEffect(() => {
    if (typeof me?.household?.cartFallback === 'boolean') setCartFallbackState(me.household.cartFallback);
  }, [me?.household?.cartFallback]);
  const setCartFallback = (on: boolean) => {
    setCartFallbackState(on);
    void setCartFallbackApi(on).catch(() => undefined);
  };
  const setCartVendor = (vendor: string) => {
    setCartVendorState(vendor);
    // Saved for next time; the screen has already moved, and a save that
    // fails leaves this session's choice standing.
    void setDefaultCartVendor(vendor).catch(() => undefined);
  };
  // The number used for the last app in this setup — most people use one
  // number everywhere, so the next app starts with it filled in. Kept in
  // memory only, never stored in the browser.
  const [lastPhone, setLastPhone] = useState('');
  // Signed in: the household's connected apps.
  const [connections, setConnections] = useState<Connection[]>([]);
  // Just joined a household: Connect says these are the person's own apps.
  const [joinedHousehold, setJoinedHousehold] = useState<string | null>(null);
  // Bumped when the household changes (someone joined, left, was removed), so
  // its orders are fetched again.
  const [householdVersion, setHouseholdVersion] = useState(0);

  useEffect(() => {
    // Coming back from a failed/cancelled Google sign-in: show the sign-in
    // screen with the reason, and drop the query string from the address bar.
    if (signInResult) {
      setStage('signin');
      window.history.replaceState(null, '', window.location.pathname);
    }
    fetchSession().then(async (s) => {
      setSession(s);
      if (s.state !== 'signed-in') {
        setChecking(false);
        return;
      }
      // Signed in: real data only — the sample household is for the preview.
      setInventory([]);
      setShoppingList([]);
      const [who, found] = await Promise.all([fetchMe(), fetchConnections().catch(() => [])]);
      setMe(who);
      setConnections(found);
      // Invited to a household: ask first, so the person's apps are connected
      // straight into it (design §19). Otherwise a household with a connected
      // app goes straight to the app (an import in progress shows in the
      // bar); without one, connect one.
      const next = who?.invites?.length ? 'join' : found.length ? 'main' : 'connect';
      setStage((prev) => (prev === 'welcome' || prev === 'signin' ? next : prev));
      setChecking(false);
    });
  }, [signInResult]);

  // Signed in: the household's imports, followed wherever they show.
  const live = session?.state === 'signed-in';
  const imports = useImports(live && (stage === 'importing' || stage === 'main'));

  // The household from its real orders, rebuilt as the import moves on.
  const learnedSkus = imports.jobs.reduce((n, j) => n + j.skusDone, 0);
  const refreshKey = `${imports.overall.phase}:${imports.overall.ordersDone}:${Math.floor(learnedSkus / HOUSEHOLD_REFRESH_SKUS)}`;
  const household = useHousehold(live && stage === 'main', me?.household?.timezone ?? null, `${householdVersion}:${refreshKey}`);
  // Where this cycle's spending is heading: the one number Home carries that
  // Stock does not. Worked out once per change, not once per render.
  // The carts being filled for this household, followed until each is done.
  const carts = useCartJobs(live && stage === 'main' && !!me?.household);
  // An order on the go belongs to the household, not to the page that started
  // it (design §19 stage 3). It may be holding a placed order waiting for a
  // bank's code, so there is always a way back to it.
  const order = useLiveOrder(live && stage === 'main' && !!me?.household);
  const [showOrder, setShowOrder] = useState(false);
  useEffect(() => {
    if (!household.data) return;
    setInventory(household.data.inventory);
    setShoppingList(household.data.shopping);
  }, [household.data]);
  // Refetched when an import starts or ends, so "synced 5 min ago" stays true.
  useEffect(() => {
    if (live && stage === 'main') fetchConnections().then(setConnections).catch(() => {});
  }, [live, stage, imports.overall.phase]);
  const learning = live && (!household.loaded || imports.overall.phase === 'running' || imports.overall.phase === 'ready');

  // Sync now: a fresh import for every connected app. Each continues where
  // its history stops; progress shows in the bar.
  const [syncing, setSyncing] = useState(false);
  const syncAll = async () => {
    setSyncing(true);
    try {
      // One call per app syncs every person's account on it.
      const vendors = new Set(connections.filter((x) => x.status === 'active').map((x) => x.vendor));
      for (const v of vendors) await retryImport(v);
      imports.refresh();
      showToast({ message: 'Syncing. New orders will show up soon.', type: 'success' });
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Could not start a sync', type: 'info' });
    } finally {
      setSyncing(false);
    }
  };

  const showToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // --- Onboarding flow ---
  const handleStartOnboarding = () => setStage(session?.state === 'signed-in' ? 'connect' : 'signin');

  const handleSignOut = async () => {
    await signOut();
    setSession({ state: 'signed-out' });
    setMe(null);
    // The last sign-in's result is history now; never show it again.
    setSignInResult(null);
    setStage('welcome');
  };

  // Refresh who we are when the main app opens (the household may have just
  // been created during connect).
  useEffect(() => {
    if (stage === 'main' && session?.state === 'signed-in') fetchMe().then(setMe);
  }, [stage, session]);

  // The household changed: who we are, its connections and its orders again.
  // Resolves to the fresh connections.
  const reloadHousehold = useCallback(async (): Promise<Connection[]> => {
    const [who, found] = await Promise.all([fetchMe(), fetchConnections().catch(() => [])]);
    setMe(who);
    setConnections(found);
    setHouseholdVersion((v) => v + 1);
    return found;
  }, []);

  // The household's items, most bought first: for "used every day" and for
  // the AI to map words to items (design §9.12, §7.8).
  const factItems = [...inventory]
    .sort((a, b) => (a.usualGapDays ?? Infinity) - (b.usualGapDays ?? Infinity) || a.name.localeCompare(b.name))
    .map((i) => ({ id: i.id, name: i.name, emoji: i.emoji, unit: i.unit ?? ('piece' as const) }));

  // Pages scroll the window: a new page starts at its top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  const openHousehold = () => {
    setView('household');
    setStage('main');
  };
  const profile =
    me && stage !== 'welcome' && stage !== 'signin' && stage !== 'join' ? (
      <ProfileMenu me={me} onSignOut={handleSignOut} onHousehold={me.household ? openHousehold : undefined} />
    ) : null;

  const handleConnectContinue = (selectedIds: SourceId[]) => {
    setConnectedSourceIds(selectedIds);
    setAuthIndex(0);
    setCurrentAuthSource(selectedIds[0]);
    setStage('auth');
  };

  const handleAuthComplete = () => {
    // Mark source as connected
    if (currentAuthSource) {
      setSources((prev) =>
        prev.map((s) =>
          s.id === currentAuthSource
            ? { ...s, connected: true, lastSynced: 'just now', ordersImported: Math.floor(Math.random() * 20) + 10 }
            : s
        )
      );
    }

    const nextIndex = authIndex + 1;
    if (nextIndex < connectedSourceIds.length) {
      setAuthIndex(nextIndex);
      setCurrentAuthSource(connectedSourceIds[nextIndex]);
      // Stay in auth stage for next source
    } else {
      setStage('importing');
    }
  };

  const handleAuthSkip = () => {
    // Skip current source, move to next or importing
    const nextIndex = authIndex + 1;
    if (nextIndex < connectedSourceIds.length) {
      setAuthIndex(nextIndex);
      setCurrentAuthSource(connectedSourceIds[nextIndex]);
    } else {
      // If no sources were authenticated, still go to importing with whatever we have
      setStage('importing');
    }
  };

  const handleImportComplete = () => setStage('learned');
  const handleLearnedComplete = () => setStage('main');

  // --- Main app actions ---
  const handleCorrectItem = (itemId: string, correction: 'more' | 'finished' | 'unsure') => {
    // Signed in: the household's word is kept by the api and applied by the
    // hook until the item is next bought. It used to be page state and was
    // gone on reload.
    if (live) {
      void household.correct(itemId, correction).catch(() => showToast({ message: 'Could not save that just now.', type: 'info' }));
      return;
    }
    setInventory((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? {
              ...item,
              userCorrected: correction,
              status: correction === 'more' ? 'plenty' : correction === 'finished' ? 'likely-low' : 'unknown',
              confidence: correction === 'unsure' ? 'low' : item.confidence,
            }
          : item
      )
    );
  };

  const handleAddMealItemsToShopping = (items: { name: string; emoji: string; reason: string }[]) => {
    const newItems: ShoppingListItem[] = items.map((item, i) => ({
      id: `meal-${Date.now()}-${i}`,
      name: item.name,
      emoji: item.emoji,
      reason: item.reason,
      urgency: 'soon' as const,
      confidence: 'high' as const,
      status: 'pending' as const,
    }));
    setShoppingList((prev) => [...newItems, ...prev]);
  };


  // --- Render ---
  if (stage === 'welcome' && checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sand-50" role="status" aria-label="Loading">
        <Loader2 className="w-6 h-6 text-ink-300 animate-spin-slow" />
      </div>
    );
  }

  if (stage === 'welcome') {
    return <Welcome onStart={handleStartOnboarding} />;
  }

  if (stage === 'signin') {
    return (
      <SignIn
        session={session}
        outcome={signInResult}
        onBack={() => setStage('welcome')}
        onPreview={() => setStage('connect')}
      />
    );
  }

  if (stage === 'join' && me?.invites?.length) {
    const invite = me.invites[0];
    // After joining: someone whose apps are already connected goes straight
    // in (their apps moved with them); everyone else connects their own.
    const joined = async () => {
      const found = await reloadHousehold();
      if (found.some((c) => c.mine)) {
        showToast({ message: `You joined ${invite.householdName}.`, type: 'success' });
        setStage('main');
      } else {
        setJoinedHousehold(invite.householdName);
        setStage('connect');
      }
    };
    const carryOn = async () => {
      const found = await reloadHousehold();
      setStage(found.length ? 'main' : 'connect');
    };
    return (
      <Join
        invite={invite}
        hasApps={connections.some((c) => c.mine !== false)}
        onJoined={joined}
        onNotNow={() => setStage(connections.length ? 'main' : 'connect')}
        onDeclined={carryOn}
      />
    );
  }

  if (stage === 'connect') {
    return (
      <>
        {profile}
        <Connect
          onContinue={handleConnectContinue}
          // Connecting another app from inside the app: Back returns there.
          onBack={() => setStage(connections.length ? 'main' : 'welcome')}
          live={session?.state === 'signed-in'}
          joinedHousehold={joinedHousehold}
        />
      </>
    );
  }

  if (stage === 'auth' && currentAuthSource) {
    const handleAuthBack = () => {
      if (authIndex > 0) {
        const prevIndex = authIndex - 1;
        setAuthIndex(prevIndex);
        setCurrentAuthSource(connectedSourceIds[prevIndex]);
      } else {
        setStage('connect');
      }
    };
    // Signed in: the real connect flow (design §7.10). Preview: the
    // prototype's simulation, on sample data.
    const ConnectStep = session?.state === 'signed-in' ? LiveConnect : Auth;
    return (
      <>
        {profile}
        <ConnectStep
          key={currentAuthSource}
          sourceId={currentAuthSource}
          onComplete={handleAuthComplete}
          onSkip={handleAuthSkip}
          onBack={handleAuthBack}
          initialPhone={lastPhone}
          onPhoneUsed={setLastPhone}
        />
      </>
    );
  }

  if (stage === 'importing') {
    // Reconnecting a vendor whose session died: back through its OTP screen.
    const reconnect = (vendor: SourceId) => {
      setConnectedSourceIds([vendor]);
      setAuthIndex(0);
      setCurrentAuthSource(vendor);
      setStage('auth');
    };
    return (
      <>
        {profile}
        {live ? (
          <LiveImporting imports={imports} onExplore={() => setStage('main')} onReconnect={reconnect} timezone={me?.household?.timezone ?? null} />
        ) : (
          <Importing connectedSources={connectedSourceIds} onComplete={handleImportComplete} />
        )}
      </>
    );
  }

  if (stage === 'learned') {
    return (
      <>
        {profile}
        <Learned connectedSources={connectedSourceIds} onComplete={handleLearnedComplete} />
      </>
    );
  }

  // Add to cart (design §19 stage 1): taps land on the list, one Send fills
  // them all, and more may be sent while one is being filled.
  // The apps this household could send a cart to: connected, working, and
  // ones this app knows how to fill.
  const cartVendorChoices = connections
    .filter((c) => c.status === 'active' && CART_VENDOR_INFO[c.vendor])
    .map((c) => CART_VENDOR_INFO[c.vendor])
    // One per APP, not per account: a household with two accounts on one
    // app was shown "Blinkit Blinkit Instamart Instamart".
    .filter((v, i, all) => all.findIndex((x) => x.id === v.id) === i);

  // Send these lines to this app. The lines and the app are passed rather
  // than read off state, because one tap on the cart sheet sends what the
  // first store did not have to the OTHER app - lines that were never on the
  // basket, to an app that is not the chosen one.
  const sendCart = async (vendor: string, lines: BasketLine[]) => {
    if (!lines.length) return;
    setSending(true);
    try {
      // Each line carries the rest of the household's ranking for its item on
      // this app, so the worker can take the next product down when the store
      // has not got the first - "Milk: packs here 1 ltr" while the 1 ltr they
      // also buy went unasked. Only products bought on this app, or on none
      // yet; never the first choice itself.
      const alternativesFor = (l: BasketLine) => {
        const item = inventory.find((i) => i.id === l.item);
        if (!item) return undefined;
        const pref = household.prefs.find((p) => p.item === l.item) ?? null;
        const alts = rankProducts(item.products ?? [], pref)
          .ranked.filter((p) => (!p.vendors.length || p.vendors.includes(vendor)) && !(p.name === l.product && (p.pack ?? '') === l.pack))
          // Only products whose pack is known: an alternative is matched
          // exactly, product AND pack, and one without a pack cannot be.
          .filter((p) => !!p.pack)
          .map((p) => ({ product: p.name, pack: p.pack! }));
        return alts.length ? alts : undefined;
      };
      const id = await carts.send(
        vendor,
        lines.map((l) => ({ item: l.item, product: l.product, pack: l.pack, qty: l.qty, match: l.match, alternatives: alternativesFor(l) })),
      );
      // Sending is an answer to what was offered, and it has to be
      // remembered the way saying no is. Without this the basket emptied,
      // the next load saw an empty basket and made the same list up again.
      const offered = lastOffer();
      if (offered) rememberSent(offered);
      // Off the list, whichever of them were on it.
      for (const l of lines) basket.remove(l.item);
      // Undo, for the seconds the toast is up. The worker claims a job almost
      // at once, so this only ever catches the tap somebody regrets straight
      // away - which is the one worth catching. Once it is running, Stop on
      // the bar is the honest offer instead, and says what it can and cannot
      // take back.
      showToast({
        message: `Filling your cart, ${lines.length} ${lines.length === 1 ? 'item' : 'items'}.`,
        type: 'undo',
        undoAction: () => {
          void cancelCart(id)
            .then(({ stopped }) => {
              // Put the list back exactly as it was, so Send is one tap away.
              if (stopped) for (const l of lines) basket.add(l);
              void carts.refresh();
              showToast({
                message: stopped ? 'Stopped. Your list is back.' : 'Already filling. Anything added stays in the cart.',
                type: 'info',
              });
            })
            .catch(() => showToast({ message: 'Too late to stop that one. Check the cart.', type: 'info' }));
        },
      });
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Could not send that just now.', type: 'info' });
    }
    setSending(false);
  };

  // Changing your mind after Send. A cart already being filled cannot be
  // killed outright - it is driving the vendor's own page - so it stops
  // after the item it is on, and whatever went in stays in the cart. The
  // household is told which of those two happened.
  const stopCart = async (id: string) => {
    try {
      const { stopped } = await cancelCart(id);
      showToast({
        message: stopped ? 'Stopped. Nothing was added.' : 'Stopping. Anything already added stays in the cart.',
        type: 'info',
      });
      carts.refresh();
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Could not stop that one.', type: 'info' });
    }
  };

  // Main app

  // Signed in: the real household; preview: the sample one.
  const history = live ? (household.data?.history ?? []) : SAMPLE_PURCHASE_HISTORY;
  // The Grocery apps page. Preview: the sample apps, as the prototype had them.
  const appRows: VendorRow[] = live
    ? vendorRows(SOURCES, connections, imports.jobs, CONNECTABLE_SOURCES, new Date(), me?.household?.timezone ?? 'Asia/Kolkata')
    : sources.map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        color: s.color,
        state: s.connected ? 'connected' : 'not_connected',
        canConnect: !s.connected,
        accounts: s.connected
          ? [
              {
                connectionId: s.id,
                who: null,
                mine: true,
                state: 'connected' as const,
                phone: 'Sample account',
                data: s.ordersImported ? `${s.ordersImported} orders` : 'No orders yet',
                lastSync: s.lastSynced ? `Last synced ${s.lastSynced}` : 'Not synced yet',
                progress: null,
                note: null,
            cannotPay: false,
                history: [],
                addresses: [],
                cartAddress: null,
              },
            ]
          : [],
      }));
  const syncApp = async (id: SourceId) => {
    if (!live) {
      showToast({ message: 'Sample data. Sign in to sync your own orders.', type: 'info' });
      return;
    }
    try {
      await retryImport(id);
      imports.refresh();
      showToast({ message: 'Sync started. New orders will show up soon.', type: 'success' });
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Could not start a sync', type: 'info' });
    }
  };
  const startConnect = (vendor: SourceId) => {
    setConnectedSourceIds([vendor]);
    setAuthIndex(0);
    setCurrentAuthSource(vendor);
    setStage('auth');
  };

  return (
    <div className="min-h-screen bg-sand-50">
      <Header
        onHome={() => setView(LANDING_VIEW)}
        right={
          live && me ? (
            <>
              <Bell />
              <ProfileMenu
                inline
                me={me}
                onSignOut={handleSignOut}
                onHousehold={me.household ? openHousehold : undefined}
                onAiSettings={me.household ? () => setView('ai') : undefined}
              />
            </>
          ) : null
        }
      />
      <div className="flex">
      <Sidebar
        activeView={view}
        onNavigate={setView}
      />

      <main className="flex-1 min-w-0">
        {live && (
          <div className="sticky top-14 z-20">
            <ImportBar imports={imports} onOpen={() => setStage('importing')} />
          </div>
        )}
        {view === 'inventory' && (
          <InventoryView
            inventory={inventory}
            prefs={live ? household.prefs : []}
            basket={basket}
            onSavePref={live ? household.savePref : undefined}
            onCorrectItem={handleCorrectItem}
            showToast={showToast}
            learning={learning}
            insight={live ? (household.data?.insight ?? null) : SAMPLE_INSIGHT}
            onRetire={
              live
                ? (item) =>
                    void household
                      .setRetired(item.id, true)
                      .then(() => showToast({ message: `${item.name} is off the list. Bring it back from the Household page.`, type: 'success' }))
                      .catch(() => showToast({ message: 'Could not save that just now.', type: 'info' }))
                : undefined
            }
            reviewing={reviewing}
            onReviewingChange={setReviewing}
            compare={live ? household.compare : []}
            // The app's questions ("buying twice as much since Aug 3: did
            // someone move in?") lived on the Household page, where nobody
            // goes. They are asked where the household is.
            asks={
              live && household.loaded && me?.household ? (
                <AskCards
                  suggestions={household.suggestions}
                  facts={household.facts}
                  timezone={me.household.timezone}
                  onChanged={() => setHouseholdVersion((v) => v + 1)}
                  onOpenHousehold={openHousehold}
                  showToast={showToast}
                />
              ) : null
            }
            cartVendor={cartVendor}
            cartVendors={cartVendorChoices}
            onCartVendor={setCartVendor}
            onSync={live && connections.some((c) => c.status === 'active') ? syncAll : undefined}
            syncing={syncing}
          />
        )}
        {view === 'cook' && (
          <CookView
            inventory={inventory}
            prefs={live ? household.prefs : []}
            basket={basket}
            live={live && !!me?.household}
            showToast={showToast}
            onOpenAiSettings={() => setView('ai')}
          />
        )}
        {view === 'history' && <HistoryView history={history} rangeDays={historyRange} onRange={setHistoryRange} now={new Date()}   basket={basket}
            live={live}
            showToast={showToast}
          />}
        {view === 'insights' && (
          <InsightsView
            insights={live ? household.insightsFor(insightsRange, me?.household?.billingDay) : null}
            onRetire={
              live
                ? (item) =>
                    void household
                      .setRetired(item, true)
                      .then(() => showToast({ message: `${item} is off the list. Bring it back from the Household page.`, type: 'success' }))
                      .catch(() => showToast({ message: 'Could not save that just now.', type: 'info' }))
                : undefined
            }
            learning={learning}
            rangeDays={insightsRange}
            onRange={setInsightsRange}
            onBillingDay={
              live
                ? (day) => {
                    // Saved, then the page is rebuilt from it: the window
                    // every number on it is counted over has changed.
                    void setBillingDay(day)
                      .then(() => {
                        setMe((who) => (who?.household ? { ...who, household: { ...who.household, billingDay: day } } : who));
                        setHouseholdVersion((n) => n + 1);
                      })
                      .catch(() => showToast({ message: 'That did not save. Try again.', type: 'info' }));
                  }
                : undefined
            }
          />
        )}
        {view === 'meals' && (
          <MealPlanView
            inventory={inventory}
            shoppingList={shoppingList}
            onAddToShoppingList={handleAddMealItemsToShopping}
            showToast={showToast}
          />
        )}
        {view === 'apps' && (
          <AppsView
            rows={appRows}
            onSync={syncApp}
            onConnect={startConnect}
            cartVendor={live ? cartVendor : null}
            cartVendors={cartVendorChoices}
            onCartVendor={live ? setCartVendor : undefined}
            cartFallback={cartFallback}
            onCartFallback={live ? setCartFallback : undefined}
            onChooseAddress={
              live
                ? async (connectionId, addressId) => {
                    await chooseCartAddress(connectionId, addressId);
                    setConnections(await fetchConnections());
                  }
                : undefined
            }
          />
        )}
        {view === 'household' && live && me && (
          <HouseholdView
            me={me}
            onChanged={reloadHousehold}
            retired={household.retired}
            onUnretire={(item) =>
              void household
                .setRetired(item, false)
                .then(() => showToast({ message: `${item} is back on the list.`, type: 'success' }))
                .catch(() => showToast({ message: 'Could not save that just now.', type: 'info' }))
            }
            facts={household.facts}
            items={factItems}
            tellUs={<TellUs items={factItems} onChanged={reloadHousehold} onOpenSettings={() => setView('ai')} showToast={showToast} />}
            asks={
              live && household.loaded && me?.household ? (
                <div className="space-y-4">
                  {!household.facts.some((f) => f.kind === 'people') && (
                    <HouseholdQuick timezone={me.household.timezone} onSaved={() => setHouseholdVersion((v) => v + 1)} />
                  )}
                </div>
              ) : undefined
            }
            onConnect={() => {
              setJoinedHousehold(null);
              setStage('connect');
            }}
            showToast={showToast}
          />
        )}
        {view === 'how' && <HowItWorksView />}
        {view === 'ai' && live && <AiSettingsView showToast={showToast} />}
        <Footer page={view} onHowItWorks={() => setView('how')} />
        {/* The cart, in one place, on every page (lib/dock.ts). */}
        {live && (
          <CartDock
            basket={basket}
            active={carts.active}
            jobs={carts.jobs}
            dismissed={seenCart}
            // Read fresh each time, not from the render's closure: letting a merged
            // cart go dismisses several ids in a row, and each must see the last.
            onDismiss={(id) => forgetCart(dismissWith(readSeen(SEEN_CART_KEY), id))}
            sending={sending}
            onSend={(vendor, lines) => void sendCart(vendor, lines)}
            onStop={stopCart}
            cartVendor={cartVendor}
            cartVendors={cartVendorChoices}
            onCartVendor={setCartVendor}
            // Chosen on the Grocery apps page: then the list offers only that
            // app, and the other app is reached through what this one lacks.
            vendorChosen={!!me?.household?.cartVendor}
            fallback={cartFallback}
            // The list rides Supplies and Cook, the two places things get
            // added. On Insights it covered the last chart and on Apps the sync
            // history, for a list nobody could change there. Ready carts show
            // everywhere: paying is reachable from any page.
            showList={view === 'inventory' || view === 'cook'}
            cardsFor={(vendor) => connections.find((c) => c.vendor === vendor)?.cards ?? []}
            inventory={inventory}
            prefs={household.prefs}
            delivery={deliveryTerms(carts.jobs, connections.find((c) => c.vendor === cartVendor)?.delivery)}
            onMoreItems={() => {
              setView('inventory');
              setReviewing(true);
            }}
            live={live && !!me?.household}
            showToast={showToast}
          />
        )}
        {/* An order that is still going: reachable from anywhere, because it
            may be waiting on a number only this household can give, and the
            order it belongs to is already placed. */}
        {order.id && !showOrder && <LiveOrderBar onOpen={() => setShowOrder(true)} />}
        {order.id && showOrder && (
          <PayNow
            toPay={carts.latestDone?.result?.bill?.toPay ?? 0}
            cards={connections.find((c) => c.vendor === (carts.latestDone?.vendor ?? cartVendor))?.cards ?? []}
            vendor={carts.latestDone?.vendor ?? cartVendor}
            resume={order.id}
            onClose={() => {
              setShowOrder(false);
              void order.refresh();
            }}
          />
        )}
      </main>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default App;
