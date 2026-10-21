// The household built from real orders, fetched while `enabled` and again
// whenever `refreshKey` changes (the import moved on). Every number in it
// comes from the engine (src/lib/household.ts); the Insights page's from the
// same orders (src/lib/insights.ts).
import { useEffect, useMemo, useState } from 'react';

import type { InventoryItem } from '../types';

import { fetchFacts, profileOf, type Fact } from './facts';
import { buildHousehold, fetchOrders, isDelivered, type ApiCoverage, type ApiOrder, type Household } from './household';
import { buildInsights, comparePrices, forecastMonth, type Insights, type MonthForecast, type PriceCompare } from './insights';
import { fetchProductPrefs, saveProductPref, type ProductPref } from './products';
import { fetchPromptedAdds, type PromptedAdd } from './prompted';
import { correctionHolds, fetchCorrections, saveCorrection, type Correction, type CorrectionKind } from './corrections';
import { fetchRetired, setRetired as setRetiredApi, type RetiredItem } from './retired';
import { suggestionsFor, type Suggestion } from './suggestions';

export function useHousehold(
  enabled: boolean,
  timezone: string | null,
  refreshKey: string,
): {
  data: Household | null;
  // The page picks the window, so the orders are kept and the insights are
  // built for whichever range is on screen (src/lib/insights.ts).
  // `billingDay`: the day the household's spending month starts, for the
  // forecast. 1 is the calendar month (design §10.5).
  insightsFor: (rangeDays: number | null, billingDay?: number) => Insights | null;
  // Where this cycle's spending is heading, on its own. Home wants only this
  // and building the whole of Insights for it would classify every line of
  // every order on every render.
  forecastFor: (billingDay?: number) => MonthForecast | null;
  facts: Fact[];
  suggestions: Suggestion[];
  loaded: boolean;
  prefs: ProductPref[];
  savePref: (item: string, ranked: string[], blocked: string[]) => Promise<void>;
  // Items the household says it no longer buys (lib/retired.ts): left out of
  // the stock list and of "not bought lately", listed on the Household page.
  retired: RetiredItem[];
  setRetired: (item: string, retired: boolean) => Promise<void>;
  // What the household said about an estimate (lib/corrections.ts): applied
  // until the item is next bought, saved so it survives a reload.
  correct: (item: string, kind: CorrectionKind | null) => Promise<void>;
  // The same product, in the same pack, cheaper on the other app. Shown on
  // the cart, where it can change a decision, not only on Insights.
  compare: PriceCompare[];
} {
  const [data, setData] = useState<Household | null>(null);
  const [insightsInput, setInsightsInput] = useState<{ orders: ApiOrder[]; coverage: ApiCoverage[]; at: Date } | null>(null);
  // What the household told us about itself (design §9.12).
  const [facts, setFacts] = useState<Fact[]>([]);
  // What the app asks the household (design §9.12 Phase 4).
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Which product to add for each item, as the household ordered them (design §19).
  const [prefs, setPrefs] = useState<ProductPref[]>([]);
  const [retired, setRetiredList] = useState<RetiredItem[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  // The whole projection, before retired items are taken out, so a change to
  // the retired list does not need the orders fetched again.
  const [full, setFull] = useState<Household | null>(null);

  useEffect(() => {
    if (!enabled || !timezone) return;
    let stale = false;
    // Facts are optional to the pages: without them, predictions run as before.
    Promise.all([
      fetchOrders(),
      fetchFacts().catch(() => [] as Fact[]),
      fetchProductPrefs().catch(() => ({ prefs: [] as ProductPref[] })),
      fetchPromptedAdds().catch(() => ({ adds: [] as PromptedAdd[] })),
      fetchRetired().catch(() => ({ items: [] as RetiredItem[] })),
      fetchCorrections().catch(() => ({ corrections: [] as Correction[] })),
    ])
      .then(([{ orders, coverage }, known, saved, prompted, gone, said]) => {
        if (stale) return;
        const now = new Date();
        setFacts(known);
        setPrefs(saved.prefs);
        setRetiredList(gone.items);
        setCorrections(said.corrections);
        setFull(buildHousehold(orders, coverage, now, timezone, profileOf(known, timezone), prompted.adds));
        setInsightsInput({ orders: orders.filter(isDelivered), coverage, at: now });
        setSuggestions(suggestionsFor(orders.filter(isDelivered), known, now, timezone));
        setLoaded(true);
      })
      .catch(() => {
        // A blip: the next refresh tries again; what's shown stays.
      });
    return () => {
      stale = true;
    };
  }, [enabled, timezone, refreshKey]);

  // What the pages see: the projection without the items the household has
  // retired. Filtered here rather than in the engine, because retiring is a
  // fact the household stated, not something the numbers worked out.
  useEffect(() => {
    if (!full) return;
    const gone = new Set(retired.map((r) => r.item));
    const inventory = full.inventory
      .filter((i) => !gone.has(i.id))
      .map((i) => {
        // The household's word about this item, while it still holds: said
        // after the last buy. A purchase since is newer evidence than the
        // word, and the word was about the stock before it.
        const c = corrections.find((x) => x.item === i.id);
        return c && correctionHolds(c, i.lastPurchasedAt ?? null) ? applyCorrection(i, c.kind) : i;
      });
    // The list follows the corrected statuses, not the engine's alone.
    const shopping = full.shopping.filter((s) => {
      const item = inventory.find((i) => i.id === s.id.replace(/^shop-/, ''));
      return !!item && (item.status === 'likely-low' || item.status === 'coming-up');
    });
    setData({ ...full, inventory, shopping });
  }, [full, retired, corrections]);

  const correct = async (item: string, kind: CorrectionKind | null) => {
    const { corrections: now } = await saveCorrection(item, kind);
    setCorrections(now);
  };

  const setRetired = async (item: string, isRetired: boolean) => {
    const { items } = await setRetiredApi(item, isRetired);
    setRetiredList(items);
  };

  const savePref = async (item: string, ranked: string[], blocked: string[]) => {
    const { pref } = await saveProductPref(item, ranked, blocked);
    setPrefs((all) => [...all.filter((p) => p.item !== item), ...(pref ? [pref] : [])]);
  };

  // Just this one part of the insights, so the cart does not pay for the
  // whole page's arithmetic to ask one question.
  const compare = useMemo(() => (insightsInput ? comparePrices(insightsInput.orders) : []), [insightsInput]);

  const forecastFor = (billingDay?: number) => (insightsInput ? forecastMonth(insightsInput.orders, insightsInput.at, timezone ?? 'UTC', billingDay) : null);

  const insightsFor = (rangeDays: number | null, billingDay?: number) => {
    if (!insightsInput || !timezone) return null;
    const i = buildInsights(insightsInput.orders, insightsInput.coverage, insightsInput.at, timezone, rangeDays, billingDay);
    // "Not bought lately" is exactly where a retired item would nag from.
    const gone = new Set(retired.map((r) => r.item.toLowerCase()));
    return { ...i, stopped: i.stopped.filter((s) => !gone.has(s.name.toLowerCase())) };
  };

  return { data, insightsFor, forecastFor, facts, suggestions, loaded, prefs, savePref, retired, setRetired, correct, compare };
}

// What a correction does to an item, as the page used to do it in state:
// "more" is not due, "finished" is due now, "unsure" is unknown and low.
function applyCorrection(item: InventoryItem, kind: CorrectionKind): InventoryItem {
  return {
    ...item,
    userCorrected: kind,
    status: kind === 'more' ? 'plenty' : kind === 'finished' ? 'likely-low' : 'unknown',
    confidence: kind === 'unsure' ? 'low' : item.confidence,
  };
}
