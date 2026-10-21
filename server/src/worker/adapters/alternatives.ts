// The next product down when the store has not got the first.
//
// Each thing on a household's list has a ranked set of products behind it -
// what they buy for "milk", most bought lately first, with anything they have
// pinned at the top (src/lib/products.ts). The worker used to be handed only
// the first and gave up when the store lacked that exact pack: "Milk - packs
// here: 1 ltr" went to the other app's tab while the household's own second
// choice, the 1 ltr, sat in their order history unasked.
//
// So a line may carry the rest of the ranking, and this walks it: the first
// product the store has and will sell is the one that goes in, and the line
// says which it was and what it stood in for. Nothing is invented - every
// alternative is a product this household has bought before - and the
// ranking itself is theirs to change on the item's sheet.
import type { CartLineResult, CartWant } from './instamart-cart.js';

export interface Setter {
  set(want: CartWant): Promise<CartLineResult>;
}

// The states in which trying the next product down is the right move. A
// failure to press a button is not one of them: the store has the thing,
// something else went wrong, and a different product would not fix it.
const TRY_NEXT: ReadonlyArray<CartLineResult['state']> = ['not_listed', 'out_of_stock'];

export async function setWithAlternatives(session: Setter, want: CartWant): Promise<CartLineResult> {
  const first = await session.set({ ...want, alternatives: undefined });
  if (!TRY_NEXT.includes(first.state) || !want.alternatives?.length) return first;

  for (const alt of want.alternatives) {
    // The same match rule as the first: an exact product and pack the
    // household has bought, never a search that takes whatever is cheapest.
    const next = await session.set({ ...want, product: alt.product, pack: alt.pack, match: 'exact', alternatives: undefined });
    if (next.inCart > 0 && !TRY_NEXT.includes(next.state)) {
      return { ...next, note: [`instead of ${want.product}`, next.note].filter(Boolean).join(' · ') };
    }
  }
  // Nothing down the list either. The first answer is the honest one - it
  // names the pack the store does have.
  return first;
}
