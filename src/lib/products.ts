// Which product to add for an item (design §19 Ordering, "which product").
// "Milk" is really Nandini Toned Milk, Amul Taaza, Akshayakalpa: the products
// the household has bought for it. The default order is its own buying (most
// bought lately first); a household's saved order (server, product-prefs)
// replaces it, and products it ruled out are never added. Pure.
import { PRODUCT_RECENT_DAYS } from './constants';
import { api } from './api';

// One product bought for an item.
export interface Product {
  name: string; // as the app names it, most recent spelling
  pack: string | null; // the pack it is usually bought in ("500 ml")
  vendors: string[]; // the apps it was bought on
  recent: number; // orders with it in the last PRODUCT_RECENT_DAYS
  total: number; // orders with it, ever
  usualCount: number; // how many are usually bought at once (the median)
  lastAt: string; // ISO time of the last order with it
}

export interface ProductPref {
  item: string;
  ranked: string[];
  blocked: string[];
  updatedAt?: string;
}

// How many of a product are usually bought at once, so the cart proposes "2
// packets of milk". The middle of the recent counts, because households
// change: this one bought 1 packet 103 times over the years and 2 packets on
// most trips of the last two months. Nothing recent → all of them; nothing at
// all → 1.
function usualCount(counts: { count: number; recent: boolean }[]): number {
  const recent = counts.filter((c) => c.recent);
  const use = (recent.length ? recent : counts).map((c) => c.count);
  if (!use.length) return 1;
  const s = use.sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Names match case- and space-insensitively.
export const productKey = (name: string) => name.toLowerCase().replace(/\s+/g, ' ').trim();

// Tallies the products bought for one item. The caller adds each product
// once per order.
export class ProductTally {
  private byKey = new Map<string, Product & { packs: Map<string, number>; counts: { count: number; recent: boolean }[]; lastMs: number }>();
  constructor(private readonly now: Date) {}

  add(name: string, pack: string | null, vendor: string, at: Date, count = 1): void {
    const k = productKey(name);
    const p = this.byKey.get(k) ?? { name, pack: null, vendors: [] as string[], recent: 0, total: 0, usualCount: 1, lastAt: at.toISOString(), counts: [] as { count: number; recent: boolean }[], packs: new Map<string, number>(), lastMs: 0 };
    this.byKey.set(k, p);
    p.total++;
    const recent = this.now.getTime() - at.getTime() <= PRODUCT_RECENT_DAYS * 86_400_000;
    if (recent) p.recent++;
    if (!p.vendors.includes(vendor)) p.vendors.push(vendor);
    if (pack) p.packs.set(pack, (p.packs.get(pack) ?? 0) + 1);
    if (count > 0) p.counts.push({ count, recent });
    if (at.getTime() >= p.lastMs) {
      p.lastMs = at.getTime();
      p.lastAt = at.toISOString();
      p.name = name;
    }
  }

  // Most bought lately first; then the one bought last; then most bought ever.
  products(): Product[] {
    return [...this.byKey.values()]
      .map((p) => ({
        name: p.name,
        pack: [...p.packs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        vendors: p.vendors,
        recent: p.recent,
        total: p.total,
        usualCount: usualCount(p.counts),
        lastAt: p.lastAt,
      }))
      .sort((a, b) => b.recent - a.recent || b.lastAt.localeCompare(a.lastAt) || b.total - a.total);
  }
}

// The order add to cart tries: the saved order first (products no longer
// bought are left out), then any product bought since, in the default order.
// Ruled-out products go to `blocked`, never into `ranked`.
export function rankProducts(products: Product[], pref: ProductPref | null): { ranked: Product[]; blocked: Product[] } {
  if (!pref) return { ranked: products, blocked: [] };
  const byKey = new Map(products.map((p) => [productKey(p.name), p]));
  const blockedKeys = new Set(pref.blocked.map(productKey));
  const ranked: Product[] = [];
  for (const n of pref.ranked) {
    const p = byKey.get(productKey(n));
    if (p && !ranked.includes(p)) ranked.push(p);
  }
  for (const p of products) if (!ranked.includes(p) && !blockedKeys.has(productKey(p.name))) ranked.push(p);
  return { ranked, blocked: products.filter((p) => blockedKeys.has(productKey(p.name))) };
}

export function fetchProductPrefs(): Promise<{ prefs: ProductPref[] }> {
  return api('GET', '/api/household/product-prefs');
}

export function saveProductPref(item: string, ranked: string[], blocked: string[]): Promise<{ pref: ProductPref | null }> {
  return api('PUT', '/api/household/product-prefs', { item, ranked, blocked });
}

// Finding one product in a long list. A household's list for an item is
// usually short - 118 of this one's 200 items have a single product - but
// chocolate has 30, and chicken, ice cream and soft drink have 14 each, so the
// long ones need a way through. Matches the name and the pack, because "500
// ml" is how someone tells two otherwise identical entries apart.
export function matchProducts(products: Product[], search: string): Product[] {
  const q = search.trim().toLowerCase();
  if (!q) return products;
  return products.filter((p) => `${p.name} ${p.pack ?? ''}`.toLowerCase().includes(q));
}


// The product to send to a particular app.
//
// A household's products carry the apps they were bought on. Ignoring that
// sent one app's names to the other: a Blinkit cart was asked for "Amul
// Pasteurised Butter", "Epigamia Greek Yogurt - Blueberry" and three more
// Instamart names, none of which Blinkit sells under those words, and every
// line came back not listed. The cart was empty and there was nothing to pay
// for.
//
// So the app being sent to chooses among the household's own products first.
// Only if they have never bought the thing there does it fall back to their
// usual one - which the worker may still fail to find, and will say so rather
// than substitute something.
export function choiceForVendor(ranked: Product[], vendor: string | null): Product | null {
  if (!ranked.length) return null;
  if (!vendor) return ranked[0];
  // Bought on this app before: their own name for it there.
  const theirs = ranked.find((p) => p.vendors.includes(vendor));
  if (theirs) return theirs;
  // Never bought there, and nothing says which app a product with no vendors
  // recorded came from - so it is still worth trying.
  return ranked.find((p) => p.vendors.length === 0) ?? ranked[0];
}

// Do they buy this on that app at all? The pages say so before sending, so a
// cart is not discovered to be empty at the vendor.
export function boughtOn(ranked: Product[], vendor: string | null): boolean {
  if (!vendor) return true;
  return ranked.some((p) => p.vendors.includes(vendor) || p.vendors.length === 0);
}
