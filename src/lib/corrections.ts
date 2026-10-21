// What the household said about an item's estimate: "I have more", "Already
// finished", "Not sure". Kept by the api (migration 031) so it survives a
// reload. A correction holds until the item is next bought after it was
// said, and then the engine takes over again: the purchase is newer evidence
// than the word, and the word was about the stock before it.
import { api } from './api';

export type CorrectionKind = 'more' | 'finished' | 'unsure';

export interface Correction {
  item: string; // the catalog's canonical name
  kind: CorrectionKind;
  saidAt: string;
}

export function fetchCorrections(): Promise<{ corrections: Correction[] }> {
  return api('GET', '/api/household/corrections');
}

export function saveCorrection(item: string, kind: CorrectionKind | null): Promise<{ corrections: Correction[] }> {
  return api('PUT', '/api/household/corrections', { item, kind });
}

// Whether a correction still speaks for the item: said after the last time
// it was bought. Pure, so the rule is testable without a page.
export function correctionHolds(c: Correction, lastPurchasedAt: string | null): boolean {
  if (!lastPurchasedAt) return true;
  return Date.parse(c.saidAt) > Date.parse(lastPurchasedAt);
}
