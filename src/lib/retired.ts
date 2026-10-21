// "We don't buy this any more" (design §9.3 by another road: an item the
// household says is over is not predicted, however good its history). The
// api keeps the list per household; the page leaves those items out of the
// stock list, the running-low list and "not bought lately", and the Household
// page shows them with a way back.
import { api } from './api';

export interface RetiredItem {
  item: string; // the catalog's canonical name ("pet pads")
  retiredAt: string;
}

export function fetchRetired(): Promise<{ items: RetiredItem[] }> {
  return api('GET', '/api/household/retired');
}

export function setRetired(item: string, retired: boolean): Promise<{ items: RetiredItem[] }> {
  return api('PUT', '/api/household/retired', { item, retired });
}
