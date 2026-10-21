// Catalog pack labels → canonical quantities (design §8, Appendix C).
// Moved here from the worker (which only stores the label as the vendor's
// catalog gives it): turning labels into quantities is engine math.
//
// "500 ml", "1 kg", "4.8 ltr", "75 Pieces", "840 Pull" → size + unit.
// Multipacks fold into the pack: "330 ml x 2" → 660 ml.
// Countable catalog units — "1 Bunch" (coriander, curry leaves), "1 Pack",
// "1 Small" (coconut) — are pieces: the label IS the unit the store sells, so
// this is read, not guessed. "1 dozen" → 12 pieces.
// No parseable size → null: the pack is unknown ("ask once", design §8) and
// the line carries no quantity. Never a guess.
import { PIECES_PER_DOZEN } from './constants';
import { toCanonical, type Unit } from './units';

export type PackUnit = 'ml' | 'l' | 'g' | 'kg' | 'piece';

export function parsePackLabel(label: string): { pack: number; unit: PackUnit } | null {
  const s = label.trim().toLowerCase();
  // A counted pack that says what is in it: Zepto writes "1 pack (500 ml)".
  // One pack is its contents. More than one ("2 pack (500 ml)") could be two
  // of 500 ml or 500 ml in all, and a wrong reading doubles or halves every
  // prediction for the item, so it is unknown - asked once, never guessed.
  const stated = s.match(/^(\d+(?:\.\d+)?)\s*(?:packs?|pcs?|pieces?|units?)\s*\(([^)]*)\)\s*$/);
  if (stated) return Number(stated[1]) === 1 ? parsePackLabel(stated[2]) : null;
  // A size the store does not fix: "500 g or 534 g" (either may come),
  // "900 g - 1 kg", "200 - 300 g" (loose produce). The smaller is the least
  // the store promises, so the pack is that: any error reminds the household
  // early, never late (design §9.5). Read as one number, these took the low
  // end of one label and the high end of another. Sizes of different kinds
  // cannot be compared, so those stay unknown.
  const choices = s.split(/\s+(?:or|-|–|to)\s+/);
  if (choices.length > 1) return smallestOf(choices);
  const mult = s.match(/[x×]\s*(\d+)\s*$/);
  const times = mult ? Number(mult[1]) : 1;
  const m = s.match(
    /(\d+(?:\.\d+)?)\s*(ml|l|ltr|litre|kg|g|gm|gms|pcs?|pieces?|units?|sheets?|pulls?|bunch(?:es)?|packs?|small|medium|large|dozen)\b/,
  );
  if (!m) return null;
  const u = m[2];
  const n = Number(m[1]) * times * (u === 'dozen' ? PIECES_PER_DOZEN : 1);
  if (u === 'ml') return { pack: n, unit: 'ml' };
  if (u === 'l' || u === 'ltr' || u === 'litre') return { pack: n, unit: 'l' };
  if (u === 'kg') return { pack: n, unit: 'kg' };
  if (u === 'g' || u === 'gm' || u === 'gms') return { pack: n, unit: 'g' };
  return { pack: n, unit: 'piece' };
}

// The smallest of several sizes, or null when any is unreadable or they are
// of different kinds. A bare number borrows the unit of the last choice:
// "200 - 300 g" is 200 g to 300 g.
function smallestOf(choices: string[]): { pack: number; unit: PackUnit } | null {
  const lastUnit = choices[choices.length - 1].replace(/^[\d.\s]+/, '');
  let best: { pack: number; unit: PackUnit; size: number } | null = null;
  let kind: Unit | null = null;
  for (const raw of choices) {
    const p = parsePackLabel(/^\d+(?:\.\d+)?$/.test(raw.trim()) ? `${raw.trim()} ${lastUnit}` : raw);
    if (!p) return null;
    const k: Unit = p.unit === 'g' || p.unit === 'kg' ? 'g' : p.unit === 'ml' || p.unit === 'l' ? 'ml' : 'piece';
    if (kind && k !== kind) return null;
    kind = k;
    const size = toCanonical(p.pack, p.unit, k);
    if (size === null) return null;
    if (!best || size < best.size) best = { ...p, size };
  }
  return best && { pack: best.pack, unit: best.unit };
}

// One order line — `count` packs of `label` — in the item's canonical unit.
// Null when the pack is unknown or in a different dimension from the item's
// base unit (a bunch of an item measured in grams): the line still counts as
// a purchase date, but carries no quantity until the pack is learned.
export function lineQty(count: number, label: string | null, base: Unit): number | null {
  if (!label) return null;
  const p = parsePackLabel(label);
  if (!p) return null;
  return toCanonical(p.pack * count, p.unit, base);
}
