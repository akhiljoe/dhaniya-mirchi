import { useState, useRef, useEffect } from 'react';
import type { InventoryItem, ShoppingListItem, Meal, MealIngredient, Toast as ToastType } from '../../types';
import { parseMealQuery, consolidateShopping, MEAL_SUGGESTIONS } from '../../data';
import {
  UtensilsCrossed,
  ArrowRight,
  Loader2,
  Check,
  Plus,
  ChevronDown,
  ChevronUp,
  X,
  Sparkles,
  ShoppingBasket,
  Clock,
  Users,
} from 'lucide-react';

interface MealPlanViewProps {
  inventory: InventoryItem[];
  shoppingList: ShoppingListItem[];
  onAddToShoppingList: (items: { name: string; emoji: string; reason: string }[]) => void;
  showToast: (toast: Omit<ToastType, 'id'>) => void;
}

type Phase = 'input' | 'thinking' | 'result';

export function MealPlanView({ inventory, shoppingList, onAddToShoppingList, showToast }: MealPlanViewProps) {
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [meals, setMeals] = useState<Meal[]>([]);
  const [expandedMeal, setExpandedMeal] = useState<string | null>(null);
  const [addedItems, setAddedItems] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const thinkingSteps = [
    'Understanding what you want to eat',
    'Checking your household inventory',
    'Matching ingredients to what you have',
    'Figuring out what you actually need',
  ];
  const [thinkingStep, setThinkingStep] = useState(0);

  const handleSubmit = () => {
    if (!query.trim()) return;
    setPhase('thinking');
    setThinkingStep(0);
    setMeals([]);
    setExpandedMeal(null);
    setAddedItems(new Set());
  };

  // Thinking animation
  useEffect(() => {
    if (phase !== 'thinking') return;
    const stepInterval = setInterval(() => {
      setThinkingStep((s) => {
        if (s >= thinkingSteps.length - 1) {
          clearInterval(stepInterval);
          return s;
        }
        return s + 1;
      });
    }, 500);
    return () => clearInterval(stepInterval);
  }, [phase]);

  // Complete thinking → generate meals
  useEffect(() => {
    if (phase !== 'thinking') return;
    const timer = setTimeout(() => {
      const parsed = parseMealQuery(query, inventory);
      setMeals(parsed);
      setPhase('result');
    }, 2500);
    return () => clearTimeout(timer);
  }, [phase, query, inventory]);

  const consolidated = phase === 'result' ? consolidateShopping(meals) : [];

  const handleAddAll = () => {
    const items = consolidated
      .filter((ing) => !addedItems.has(ing.name.toLowerCase()))
      .map((ing) => ({
        name: ing.name,
        emoji: ing.emoji,
        reason: `Needed for ${meals.map((m) => m.name).join(', ')}`,
      }));
    if (items.length === 0) return;
    onAddToShoppingList(items);
    const allNames = new Set(addedItems);
    consolidated.forEach((ing) => allNames.add(ing.name.toLowerCase()));
    setAddedItems(allNames);
    showToast({ message: `${items.length} items added to your shopping list`, type: 'success' });
  };

  const handleAddOne = (ing: MealIngredient) => {
    const key = ing.name.toLowerCase();
    if (addedItems.has(key)) return;
    onAddToShoppingList([
      {
        name: ing.name,
        emoji: ing.emoji,
        reason: `Needed for ${meals.map((m) => m.name).join(', ')}`,
      },
    ]);
    setAddedItems((prev) => new Set(prev).add(key));
    showToast({ message: `${ing.name} added to your shopping list`, type: 'success' });
  };

  const handleReset = () => {
    setPhase('input');
    setQuery('');
    setMeals([]);
    setExpandedMeal(null);
    setAddedItems(new Set());
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const alreadyOnList = (name: string) =>
    shoppingList.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.status === 'pending');

  // --- INPUT PHASE ---
  if (phase === 'input') {
    return (
      <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6 scroll-area">
        <div className="mb-6 animate-fade-in-down">
          <h1 className="font-display text-2xl text-ink-900 mb-1">Plan a meal</h1>
          <p className="text-sm text-ink-400">
            Tell us what you want to eat. We'll check your inventory and figure out what you actually need to buy.
          </p>
        </div>

        {/* Input card */}
        <div className="card p-5 mb-5 animate-fade-in-up">
          <div className="flex items-center gap-2 mb-3">
            <UtensilsCrossed className="w-5 h-5 text-sage-600" />
            <span className="text-sm font-semibold text-ink-700">What do you want to eat?</span>
          </div>
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="e.g. Chicken biryani for 4 tonight and pasta tomorrow"
            className="input-field min-h-[80px] resize-none"
            autoFocus
          />
          <div className="flex items-center justify-between mt-3">
            <p className="text-2xs text-ink-400">
              Be as vague or specific as you like. We'll make sensible assumptions.
            </p>
            <button
              onClick={handleSubmit}
              disabled={!query.trim()}
              className="btn-primary text-sm"
            >
              Plan meals
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Suggestions */}
        <div className="mb-6">
          <p className="text-xs font-semibold text-ink-400 uppercase tracking-wide mb-2.5">
            Try one of these
          </p>
          <div className="flex flex-wrap gap-2">
            {MEAL_SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setQuery(s);
                  inputRef.current?.focus();
                }}
                className="px-3.5 py-2 rounded-full bg-surface border border-sand-200 text-sm text-ink-600 hover:border-sage-300 hover:bg-sage-50 transition-all"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* How it works */}
        <div className="flex items-start gap-3 p-4 rounded-2xl bg-sand-100/60">
          <Sparkles className="w-5 h-5 text-sage-600 shrink-0 mt-0.5" />
          <div className="text-sm text-ink-500 leading-relaxed">
            <span className="font-medium text-ink-600">How it works:</span>{' '}
            We match your meal to what's already in your household inventory,
            so you only buy what you're actually missing. It feeds straight into your shopping list.
          </div>
        </div>
      </div>
    );
  }

  // --- THINKING PHASE ---
  if (phase === 'thinking') {
    return (
      <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6 scroll-area">
        <div className="flex flex-col items-center justify-center py-16">
          <div className="relative mb-8">
            <div className="w-16 h-16 rounded-2xl bg-sage-100 flex items-center justify-center">
              <UtensilsCrossed className="w-8 h-8 text-sage-600" />
            </div>
            <Loader2 className="absolute -bottom-1 -right-1 w-7 h-7 text-ink-600 bg-sand-50 rounded-full p-1 animate-spin-slow" />
          </div>

          <h2 className="font-display text-xl text-ink-900 mb-2">Planning your meals</h2>
          <p className="text-sm text-ink-400 mb-8 text-center max-w-sm">
            "{query}"
          </p>

          <div className="w-full max-w-sm space-y-1">
            {thinkingSteps.map((step, i) => {
              const isDone = i < thinkingStep;
              const isActive = i === thinkingStep;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-3 p-3 rounded-xl transition-all duration-300 ${
                    isActive ? 'bg-surface shadow-soft' : isDone ? 'opacity-60' : 'opacity-30'
                  }`}
                >
                  <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0">
                    {isDone ? (
                      <div className="w-6 h-6 rounded-full bg-sage-500 flex items-center justify-center animate-check-pop">
                        <Check className="w-3.5 h-3.5 text-sand-50" />
                      </div>
                    ) : isActive ? (
                      <Loader2 className="w-5 h-5 text-ink-600 animate-spin-slow" />
                    ) : (
                      <div className="w-6 h-6 rounded-full border-2 border-sand-300" />
                    )}
                  </div>
                  <span className={`text-sm ${isActive || isDone ? 'text-ink-700' : 'text-ink-400'}`}>
                    {step}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // --- RESULT PHASE ---
  const totalNeed = consolidated.length;
  const totalHave = meals.reduce((sum, m) => sum + m.haveItems.length, 0);

  return (
    <div className="max-w-2xl mx-auto px-5 md:px-8 py-6 pb-4 md:pb-6 scroll-area">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 animate-fade-in-down">
        <div>
          <h1 className="font-display text-2xl text-ink-900 mb-1">Your meal plan</h1>
          <p className="text-sm text-ink-400">
            {meals.length} {meals.length === 1 ? 'meal' : 'meals'} · {totalHave} ingredients at home · {totalNeed} to buy
          </p>
        </div>
        <button onClick={handleReset} className="btn-ghost text-xs shrink-0">
          <X className="w-4 h-4" />
          New plan
        </button>
      </div>

      {/* Original query */}
      <div className="flex items-start gap-2.5 p-3 rounded-xl bg-sand-100/60 mb-5 animate-fade-in">
        <Sparkles className="w-4 h-4 text-sage-600 shrink-0 mt-0.5" />
        <p className="text-sm text-ink-500 italic">"{query}"</p>
      </div>

      {/* Meals */}
      <div className="space-y-3 mb-6">
        {meals.map((meal, idx) => {
          const isExpanded = expandedMeal === meal.id;
          return (
            <div
              key={meal.id}
              className="card overflow-hidden animate-fade-in-up"
              style={{ animationDelay: `${idx * 0.1}s` }}
            >
              {/* Meal header */}
              <button
                onClick={() => setExpandedMeal(isExpanded ? null : meal.id)}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-sand-50/50 transition-colors"
              >
                <div className="w-12 h-12 rounded-xl bg-sand-100 flex items-center justify-center text-2xl shrink-0">
                  {meal.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-ink-800">{meal.name}</div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-2xs text-ink-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {meal.when}
                    </span>
                    <span className="text-2xs text-ink-400 flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {meal.servings}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-2xs text-sage-600 font-medium">
                    {meal.haveItems.length} at home
                  </div>
                  <div className="text-2xs text-clay-500 font-medium mt-0.5">
                    {meal.needItems.length} to buy
                  </div>
                </div>
                {isExpanded ? (
                  <ChevronUp className="w-5 h-5 text-ink-300 shrink-0" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-ink-300 shrink-0" />
                )}
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="px-4 pb-4 animate-fade-in">
                  <div className="border-t border-sand-100 pt-3 space-y-3">
                    {/* Have */}
                    {meal.haveItems.length > 0 && (
                      <div>
                        <p className="text-2xs font-semibold text-sage-600 uppercase tracking-wide mb-1.5">
                          You already have
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {meal.haveItems.map((ing, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sage-50 text-xs text-sage-700"
                            >
                              <Check className="w-3 h-3" />
                              {ing.emoji} {ing.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Need */}
                    {meal.needItems.length > 0 && (
                      <div>
                        <p className="text-2xs font-semibold text-clay-500 uppercase tracking-wide mb-1.5">
                          You'll need
                        </p>
                        <div className="space-y-1.5">
                          {meal.needItems.map((ing, i) => {
                            const key = ing.name.toLowerCase();
                            const isAdded = addedItems.has(key);
                            const isAlreadyOnList = alreadyOnList(ing.name);
                            return (
                              <div
                                key={i}
                                className="flex items-center gap-2.5 py-1.5 px-2.5 rounded-lg bg-sand-50"
                              >
                                <span className="text-base">{ing.emoji}</span>
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm text-ink-700">{ing.name}</span>
                                  <span className="text-xs text-ink-400 ml-2">{ing.quantity}</span>
                                </div>
                                {isAlreadyOnList ? (
                                  <span className="text-2xs text-sage-600 font-medium">
                                    On your list
                                  </span>
                                ) : isAdded ? (
                                  <span className="text-2xs text-sage-600 font-medium flex items-center gap-1">
                                    <Check className="w-3 h-3" /> Added
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => handleAddOne(ing)}
                                    className="p-1 rounded-lg hover:bg-sand-200 text-ink-400 hover:text-ink-600 transition-colors"
                                  >
                                    <Plus className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Consolidated shopping */}
      {totalNeed > 0 && (
        <section className="mb-6 animate-fade-in-up" style={{ animationDelay: '0.3s' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ShoppingBasket className="w-4 h-4 text-ink-500" />
              <h2 className="text-sm font-semibold text-ink-500 uppercase tracking-wide">
                Groceries you need
              </h2>
            </div>
            <span className="text-xs text-ink-400">{totalNeed} items</span>
          </div>

          <div className="card p-4">
            <div className="space-y-1">
              {consolidated.map((ing, i) => {
                const key = ing.name.toLowerCase();
                const isAdded = addedItems.has(key);
                const isAlreadyOnList = alreadyOnList(ing.name);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-3 py-2 group"
                  >
                    <span className="text-lg">{ing.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-ink-700">{ing.name}</span>
                      <span className="text-xs text-ink-400 ml-2">{ing.quantity}</span>
                    </div>
                    {isAlreadyOnList ? (
                      <span className="text-2xs text-sage-600 font-medium">
                        On your list
                      </span>
                    ) : isAdded ? (
                      <span className="text-2xs text-sage-600 font-medium flex items-center gap-1">
                        <Check className="w-3 h-3" /> Added
                      </span>
                    ) : (
                      <button
                        onClick={() => handleAddOne(ing)}
                        className="p-1.5 rounded-lg hover:bg-sand-100 text-ink-300 hover:text-ink-600 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              onClick={handleAddAll}
              disabled={addedItems.size >= totalNeed}
              className="btn-primary w-full mt-3 text-sm"
            >
              {addedItems.size >= totalNeed ? (
                <>
                  <Check className="w-4 h-4" />
                  All items added
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Add all {totalNeed - addedItems.size} to shopping list
                </>
              )}
            </button>
          </div>
        </section>
      )}

      {totalNeed === 0 && (
        <div className="text-center py-12 animate-fade-in">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-sage-100 mb-4">
            <Check className="w-7 h-7 text-sage-600" />
          </div>
          <h3 className="font-display text-xl text-ink-800 mb-2">You have everything</h3>
          <p className="text-ink-400 text-sm max-w-xs mx-auto">
            Your household inventory covers all the ingredients for this meal plan. No shopping needed.
          </p>
        </div>
      )}
    </div>
  );
}
