import { useEffect, useRef, useState } from 'react';
import { Check, ChefHat, Loader2, Send, ShoppingCart, Sparkles } from 'lucide-react';

import type { InventoryItem, Toast } from '../../types';
import { firstChoice } from '@/components/YourProducts';
import { ApiError } from '@/lib/api';
import type { Basket } from '@/lib/basket';
import { AI_ERROR_FALLBACK, AI_ERROR_TEXT, fetchAiSettings, saveKey } from '@/lib/ai';
import { AI_POLL_MS, AI_WAIT_MS, COOK_EXAMPLES } from '@/lib/constants';
import { amountText, askForMeal, getMeal, planFor, type Meal, type MealLine } from '@/lib/meals';
import type { ProductPref } from '@/lib/products';

interface CookViewProps {
  inventory: InventoryItem[];
  prefs: ProductPref[];
  basket: Basket;
  live: boolean;
  showToast: (toast: Omit<Toast, 'id'>) => void;
  onOpenAiSettings: () => void;
}

// "What do you want to make?" (design §19 "AI mode"). The model lists what
// the dish needs; the app says what is already at home and what to buy, and
// puts the rest on the cart list. Nothing here changes an estimate.
export function CookView({ inventory, prefs, basket, live, showToast, onOpenAiSettings }: CookViewProps) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'plan'>('idle');
  const [meal, setMeal] = useState<Meal | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether an AI is reachable at all: null while asking, false when there is
  // no key and no allowance. Asked once, on arrival.
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let stale = false;
    fetchAiSettings()
      .then((s) => {
        if (!stale) setReady(s.available && !s.paused);
      })
      // A blip is not the same as "no key": say nothing rather than send
      // them to settings they may not need.
      .catch(() => {
        if (!stale) setReady(true);
      });
    return () => {
      stale = true;
    };
  }, []);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const stopped = useRef(false);

  // The key, typed here rather than on the settings page.
  const [key, setKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const addKey = async () => {
    setSavingKey(true);
    try {
      await saveKey(key.trim());
      setKey('');
      setReady(true);
      showToast({ message: 'Key saved. Name a dish.', type: 'success' });
    } catch (err) {
      showToast({ message: err instanceof ApiError ? err.message : 'Could not save the key. Please try again.', type: 'info' });
    } finally {
      setSavingKey(false);
    }
  };

  const ask = async (what: string) => {
    if (!what.trim()) return;
    if (!live) {
      showToast({ message: 'Sample data. Sign in to plan your own meals.', type: 'info' });
      return;
    }
    setError(null);
    setPhase('thinking');
    setSkipped(new Set());
    try {
      const { id } = await askForMeal(
        what,
        inventory.map((i) => ({ id: i.id, unit: i.unit ?? 'piece' })),
      );
      const started = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, AI_POLL_MS));
        if (stopped.current) return;
        const r = await getMeal(id);
        if (r.status === 'done' && r.result?.meal) {
          setMeal(r.result.meal);
          setPhase('plan');
          return;
        }
        if (r.status === 'failed') throw new Error(AI_ERROR_TEXT[r.errorCode ?? ''] ?? AI_ERROR_FALLBACK);
        if (Date.now() - started > AI_WAIT_MS) throw new Error(AI_ERROR_TEXT.provider_down);
      }
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : AI_ERROR_FALLBACK);
      setPhase('idle');
    }
  };

  const lines = meal ? planFor(meal, inventory) : [];
  const toBuy = lines.filter((l) => (l.state === 'check' || l.state === 'new') && !skipped.has(l.ingredient.name));
  const atHome = lines.filter((l) => l.state === 'have' || l.state === 'pantry');

  const addAll = () => {
    for (const line of toBuy) {
      const product = line.item ? firstChoice(line.item, prefs.find((p) => p.item === line.item!.id) ?? null) : null;
      basket.add({
        item: line.item?.id ?? line.ingredient.name,
        name: line.item?.name ?? line.ingredient.name,
        emoji: line.item?.emoji ?? '🛒',
        // Never bought here: the store's own product, chosen when it is added
        // (the result says which), so a recipe is not stuck on what we know.
        product: product?.name ?? line.ingredient.name,
        pack: product?.pack ?? '',
        qty: product?.usualCount || 1,
        match: product ? 'exact' : 'search',
      });
    }
    showToast({ message: `${toBuy.length} on the cart list. Send it from the bar below.`, type: 'success' });
  };

  return (
    <div className="max-w-3xl mx-auto px-5 md:px-8 py-6 pb-24 md:pb-6 scroll-area">
      <div className="mb-5 animate-fade-in-down">
        <h1 className="font-display text-2xl text-ink-900 mb-1">Cook something</h1>
        <p className="text-sm text-ink-400">Name a dish. Get the list.</p>
      </div>

      {/* Asked before anything is typed. This needs an AI key and has never
          had one, so without this the household writes out a dish, waits, and
          is told no at the end of it. */}
      {/* The key field is right here. A tab that said "nothing here works"
          and sent people to another page was a dead end a stranger never
          came back from; pasting the key where it is needed is one step. */}
      {ready === false && (
        <div className="card p-4">
          <p className="text-sm text-ink-700">Paste an AI key to turn this on.</p>
          <p className="text-xs text-ink-500 mt-1">It runs on your key, at your cost: about ₹3 a month at normal use.</p>
          <form
            className="flex gap-2 mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void addKey();
            }}
          >
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-..."
              aria-label="AI key"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-0 rounded-xl border border-sand-200 bg-surface px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
            />
            <button type="submit" disabled={savingKey || !key.trim()} className="btn-primary text-sm py-2 px-4">
              {savingKey ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : 'Save'}
            </button>
          </form>
          <button onClick={onOpenAiSettings} className="text-xs font-medium text-sage-700 hover:underline mt-2">
            How to get a key
          </button>
        </div>
      )}

      {ready !== false && phase !== 'plan' && (
        <div className="card p-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            rows={2}
            disabled={phase === 'thinking'}
            placeholder="Chicken biryani for 6"
            className="w-full px-3 py-2.5 rounded-xl border border-sand-200 text-sm focus:outline-none focus:border-sage-400 resize-none"
          />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {COOK_EXAMPLES.map((e) => (
              <button key={e} onClick={() => setText(e)} disabled={phase === 'thinking'} className="chip bg-sand-100 text-ink-600 hover:bg-sand-200">
                {e}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-clay-600 mt-2">{error}</p>}
          <div className="flex items-center justify-between gap-3 mt-3">
            <button onClick={onOpenAiSettings} className="text-2xs text-ink-400 hover:text-ink-600 text-left">
              An AI writes the list. Nothing is bought until you send it.
            </button>
            <button onClick={() => ask(text)} disabled={phase === 'thinking' || !text.trim()} className="btn-primary text-sm py-2 px-4 shrink-0">
              {phase === 'thinking' ? <Loader2 className="w-4 h-4 animate-spin-slow" /> : <Send className="w-4 h-4" />}
              {phase === 'thinking' ? 'Thinking' : 'What do I need?'}
            </button>
          </div>
        </div>
      )}

      {phase === 'plan' && meal && (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="flex items-start gap-3">
              <ChefHat className="w-5 h-5 text-sage-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink-800 capitalize">{meal.dish}</p>
                <p className="text-xs text-ink-500">Serves {meal.serves}</p>
                {meal.note && <p className="text-xs text-ink-400 mt-1">{meal.note}</p>}
              </div>
              <button
                onClick={() => {
                  setPhase('idle');
                  setMeal(null);
                }}
                className="text-xs font-medium text-ink-400 hover:text-ink-600 shrink-0"
              >
                Change
              </button>
            </div>
          </div>

          <Section title={`To buy (${toBuy.length})`}>
            {toBuy.length === 0 && <p className="text-sm text-ink-500">You have it all.</p>}
            {lines
              .filter((l) => l.state === 'check' || l.state === 'new')
              .map((l) => (
                <Row
                  key={l.ingredient.name}
                  line={l}
                  skipped={skipped.has(l.ingredient.name)}
                  onToggle={() =>
                    setSkipped((s) => {
                      const next = new Set(s);
                      if (next.has(l.ingredient.name)) next.delete(l.ingredient.name);
                      else next.add(l.ingredient.name);
                      return next;
                    })
                  }
                />
              ))}
            {toBuy.length > 0 && (
              <button onClick={addAll} className="btn-primary text-sm py-2 px-4 mt-1">
                <ShoppingCart className="w-4 h-4" />
                Add {toBuy.length} to the list
              </button>
            )}
          </Section>

          {atHome.length > 0 && (
            <Section title={`Already at home (${atHome.length})`}>
              {atHome.map((l) => (
                <div key={l.ingredient.name} className="flex items-center gap-2 py-1.5 text-sm text-ink-600">
                  <Check className="w-4 h-4 text-sage-600 shrink-0" />
                  <span className="capitalize flex-1 min-w-0 truncate">{l.ingredient.name}</span>
                  <span className="text-xs text-ink-400">{amountText(l.ingredient)}</span>
                </div>
              ))}
            </Section>
          )}

          <p className="text-2xs text-ink-400">
            The amounts come from the AI. What's at home is this app's own estimate, so check anything you're unsure of.
          </p>
        </div>
      )}

      {phase === 'idle' && !meal && (
        <div className="mt-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-sage-100 mb-3">
            <Sparkles className="w-7 h-7 text-sage-600" />
          </div>
          <p className="text-sm text-ink-500 max-w-xs mx-auto">A dish, a number of people, or just "something with paneer".</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide mb-2">{title}</h2>
      <div className="card p-4 space-y-1.5">{children}</div>
    </section>
  );
}

function Row({ line, skipped, onToggle }: { line: MealLine; skipped: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center gap-3 py-1.5 text-left">
      <span
        className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
          skipped ? 'border-sand-300 bg-surface' : 'border-sage-500 bg-sage-500'
        }`}
      >
        {!skipped && <Check className="w-3.5 h-3.5 text-sand-50" />}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`text-sm capitalize ${skipped ? 'text-ink-400 line-through' : 'text-ink-800'}`}>{line.ingredient.name}</span>
        <span className="block text-2xs text-ink-400">
          {amountText(line.ingredient)}
          {line.state === 'check' ? ' · you buy this, likely running low' : ' · not bought here before'}
          {!line.ingredient.essential ? ' · optional' : ''}
        </span>
      </span>
    </button>
  );
}
