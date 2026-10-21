// Canonical units: everything stored and computed as ml | g | piece.
// Conversion factors and display thresholds live in ./constants.
import { DISPLAY_LARGE_UNIT_AT, UNIT_FACTORS } from './constants';

export type Unit = 'ml' | 'g' | 'piece';

// Convert a (quantity, rawUnit) into the item's canonical base unit.
// Returns null when there is no honest conversion: an unknown raw unit, or a
// different dimension than the base (e.g. "1 bunch" of coriander — a piece —
// for an item measured in g). Treating 1 piece as 1 g would silently corrupt
// the item's rate, so the caller must skip the line (and surface it as a pack
// to learn) rather than guess a factor. (design §8)
export function toCanonical(qty: number, rawUnit: string, base: Unit): number | null {
  const f = UNIT_FACTORS[rawUnit.toLowerCase()];
  if (f && f.unit === base) return qty * f.f;
  return null;
}

export function formatQty(qty: number, unit: Unit): string {
  if (unit === 'piece') return `${Math.round(qty)}`;
  const big = qty >= DISPLAY_LARGE_UNIT_AT;
  if (unit === 'ml') return big ? `${(qty / DISPLAY_LARGE_UNIT_AT).toFixed(1)} L` : `${Math.round(qty)} ml`;
  return big ? `${(qty / DISPLAY_LARGE_UNIT_AT).toFixed(1)} kg` : `${Math.round(qty)} g`;
}
