// Product name → canonical household item (design §8). Pure; shared like the
// engine. The rules live in ./rules — edit them there.
import { CATEGORY_EMOJI, CATEGORY_LABEL, FALLBACK_NAME_WORDS, ITEM_EMOJI, PREPARED_ITEM, RULES, type BaseUnit, type Category } from './rules';

export type { BaseUnit, Category } from './rules';

export interface Classified {
  canonical: string; // 'milk'
  category: Category;
  unit: BaseUnit;
  emoji: string;
}

// The long tail of one-offs: the product name minus sizes, pack counts and
// offers, first few words.
function stripFallback(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(kg|g|gm|ml|l|pcs|piece|pieces|pack|ply)\b/g, ' ')
    .replace(/\bpack of \d+\b/g, ' ')
    .replace(/\bbuy \d+ get \d+ free\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, FALLBACK_NAME_WORDS)
    .join(' ');
}

// For a product no rule knows, the pack label says what dimension it's sold
// in ("500 g" → weighed). No label → counted in pieces.
function unitFromPack(packLabel: string | null): BaseUnit {
  if (!packLabel) return 'piece';
  const s = packLabel.toLowerCase();
  if (/\d\s*(ml|l|ltr|litre)\b/.test(s)) return 'ml';
  if (/\d\s*(g|gm|gms|kg)\b/.test(s)) return 'g';
  return 'piece';
}

// Pure, so answers are cached: the pages and the backtest classify the same
// few hundred names over and over. Callers must not mutate the result.
const cache = new Map<string, Classified>();

export function classify(name: string, packLabel: string | null): Classified {
  const key = JSON.stringify([name, packLabel]);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = classifyUncached(name, packLabel);
  cache.set(key, result);
  return result;
}

function classifyUncached(name: string, packLabel: string | null): Classified {
  for (const [re, canonical, category, unit] of RULES) {
    if (re.test(name)) return { canonical, category, unit, emoji: ITEM_EMOJI[canonical] ?? CATEGORY_EMOJI[category] };
  }
  const canonical = stripFallback(name) || name.toLowerCase();
  return { canonical, category: 'other', unit: unitFromPack(packLabel), emoji: ITEM_EMOJI[canonical] ?? CATEGORY_EMOJI.other };
}

// An order line, classified. A line the vendor itself marks as made to eat
// now is café food whatever its name says: "Chicken Puff" is not chicken,
// and counting it as chicken tells the household how often they buy chicken
// wrong (Zepto, design Appendix D).
export function classifyLine(l: { name: string; packLabel: string | null; prepared?: boolean | null }): Classified {
  if (l.prepared) return { canonical: PREPARED_ITEM, category: 'prepared', unit: 'piece', emoji: CATEGORY_EMOJI.prepared };
  return classify(l.name, l.packLabel);
}

// Whether a classified line is something kept at home: what Supplies, the
// running-low list and advice are about. Not groceries and ready-to-eat food
// are neither; ready-to-eat still counts wherever money is counted.
export function isStock(c: Classified): boolean {
  return c.category !== 'exclude' && c.category !== 'prepared';
}

export function displayName(canonical: string): string {
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
}

export function categoryLabel(category: Category): string {
  return CATEGORY_LABEL[category];
}
