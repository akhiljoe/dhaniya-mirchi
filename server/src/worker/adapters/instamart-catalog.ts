// Reading Instamart's own catalog answers (design Appendix C, "the cart").
// Pure: what to look for on the page is decided here, from the vendor's JSON,
// and the page driving (instamart-cart.ts) only carries it out.
//
// Why images, not names: the search page scrambles product names in its text
// ("Nandini Pa teuri ed Toned Milk"), and one product can have several
// listings under one name (Milky Mist Set Curd: 1 kg, and 200 g). The image
// files of a listing are in the search answer and on the card, so they say
// which card is which.

export interface Variation {
  skuId: string;
  spinId?: string;
  displayName: string;
  quantityDescription: string; // "500 ml", "1 kg"
  price?: { offerPrice?: { units?: string }; mrp?: { units?: string } };
  inventory?: { inStock?: boolean };
  imageIds?: string[];
}

export interface Found {
  variation: Variation | null; // null: this store does not list it
  price: number | null;
  inStock: boolean;
  imageKeys: string[]; // image file names of the whole listing, for the card
  packsSeen: string[]; // the packs this store does list, for the message
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function walk(json: unknown, hit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(json)) return json.forEach((x) => walk(x, hit));
  if (json && typeof json === 'object') {
    hit(json as Record<string, unknown>);
    Object.values(json as Record<string, unknown>).forEach((x) => walk(x, hit));
  }
}

function collect(json: unknown): { variations: Variation[]; listings: Variation[][] } {
  const variations: Variation[] = [];
  const listings: Variation[][] = [];
  walk(json, (o) => {
    if (typeof o.skuId === 'string' && typeof o.displayName === 'string') variations.push(o as unknown as Variation);
    if (Array.isArray(o.variations) && (o.variations as unknown[]).every((v) => v && typeof (v as Variation).skuId === 'string')) {
      listings.push(o.variations as unknown as Variation[]);
    }
  });
  return { variations, listings };
}

// The exact product and pack in a search answer: same name, same pack label.
// Null when this store doesn't list it (the packs it does list come back for
// the message).
export function findVariation(searchJson: unknown, name: string, pack: string): Found {
  const { variations, listings } = collect(searchJson);
  const sameName = variations.filter((v) => norm(v.displayName) === norm(name));
  const packsSeen = [...new Set(sameName.map((v) => v.quantityDescription))];
  const variation = sameName.find((v) => norm(v.quantityDescription) === norm(pack));
  if (!variation) return { variation: null, price: null, inStock: false, imageKeys: [], packsSeen };
  const listing = listings.find((l) => l.includes(variation)) ?? [variation];
  const price = Number(variation.price?.offerPrice?.units);
  return {
    variation,
    price: Number.isFinite(price) ? price : null,
    inStock: variation.inventory?.inStock !== false,
    imageKeys: [...new Set(listing.flatMap((v) => v.imageIds ?? []).map((id) => id.split('/').pop() ?? '').filter((k) => k.length >= 12))],
    packsSeen,
  };
}

// A delivery address the household has saved in the app. The store, and so
// which cart the app shows, follows from it: Instamart keeps a cart per
// store, so the worker must choose the household's own address every time.
export interface VendorAddress {
  id: string;
  // False, or absent, while this is only our match from the address the
  // household's orders go to: the page then asks rather than assumes.
  chosenByHousehold?: boolean;
  label: string; // what the household called it ("Maple Residency")
  display: string; // the address as the app shows it
  lat: number;
  lng: number;
  // Who the app says the parcel is for. Not always the account holder: an
  // address can be shared to an account from somebody else's.
  name: string;
  // Where the address came from, in the vendor's own words, when it says.
  // Blinkit's `address_meta.source`: ZOMATO_IMPORT, ZOMATO, SHARED_ADDRESS,
  // or absent for one saved on Blinkit itself. The household needs this to
  // tell apart four entries all labelled "Home" in four cities (design
  // Appendix A). Instamart does not say, and absent is not a failure.
  source?: string;
}

// The account's own id at the vendor, which its saved addresses are asked
// for by ("customerId"). It comes back in the login answer and in the order
// list, so an app connected before this was needed doesn't have to be
// connected again.
export function readCustomerId(json: unknown): string | null {
  let found: string | null = null;
  walk(json, (o) => {
    if (found) return;
    const v = o.customer_id ?? o.customerId;
    if ((typeof v === 'string' && /^\d{3,}$/.test(v)) || (typeof v === 'number' && Number.isInteger(v))) found = String(v);
  });
  return found;
}

// The saved addresses out of the app's answer (GET maps/getUserAddresses).
// The household's own label for an address is its first tag ("Maple Residency"),
// and the coordinates are what the app's address picker sends when it
// switches store. Anything without an id or coordinates is left out: a
// half-known address would fill a cart at the wrong store.
//
// Only what is needed to choose a store is taken: no phone, no contact name,
// no street lines (design §7.6).
export function readAddresses(json: unknown): VendorAddress[] {
  const out: VendorAddress[] = [];
  walk(json, (o) => {
    const actual = o.actual_address as Record<string, unknown> | undefined;
    if (typeof o.id !== 'string' || !actual || typeof actual !== 'object') return;
    const location = (actual.location ?? {}) as Record<string, unknown>;
    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const tags = Array.isArray(actual.tags) ? actual.tags.filter((t): t is string => typeof t === 'string') : [];
    out.push({
      id: o.id,
      label: tags[0] ?? '',
      display: String(o.display_address ?? actual.formatted_address ?? ''),
      lat,
      lng,
      name: String((actual.account_details as Record<string, unknown>)?.name ?? ''),
    });
  });
  return out;
}

// The address a cart should be filled for: the household's own label first,
// then an address that contains it, then the only one there is. Null means
// "don't guess": filling a cart for someone else's address is worse than
// stopping.
export function pickAddress(addresses: VendorAddress[], label: string | null): VendorAddress | null {
  const want = (label ?? '').toLowerCase().trim();
  if (want) {
    const byLabel = addresses.find((a) => a.label.toLowerCase().trim() === want);
    if (byLabel) return byLabel;
    const inDisplay = addresses.find((a) => a.display.toLowerCase().includes(want));
    if (inDisplay) return inDisplay;
  }
  return addresses.length === 1 ? addresses[0] : null;
}

// What the store sells for something the household has never bought (a
// recipe's new ingredient): the first listing whose name carries every word
// asked for, and its cheapest pack that is in stock. The store's own order is
// its relevance, so the first match is what a person would see first. Null
// when nothing matches: the page then says so rather than adding a guess.
export function findBySearch(searchJson: unknown, query: string): Found {
  const { variations, listings } = collect(searchJson);
  const words = norm(query).split(' ').filter(Boolean);
  const matches = (v: Variation) => {
    const name = norm(v.displayName);
    return words.every((w) => name.includes(w));
  };
  const listing = listings.find((l) => l.some(matches)) ?? (variations.find(matches) ? [variations.find(matches)!] : null);
  if (!listing) return { variation: null, price: null, inStock: false, imageKeys: [], packsSeen: [] };
  const inStock = listing.filter((v) => v.inventory?.inStock !== false);
  const priceOf = (v: Variation) => Number(v.price?.offerPrice?.units ?? Infinity);
  const variation = [...(inStock.length ? inStock : listing)].sort((a, b) => priceOf(a) - priceOf(b))[0];
  const price = priceOf(variation);
  return {
    variation,
    price: Number.isFinite(price) ? price : null,
    inStock: variation.inventory?.inStock !== false,
    imageKeys: [...new Set(listing.flatMap((v) => v.imageIds ?? []).map((id) => id.split('/').pop() ?? '').filter((k) => k.length >= 12))],
    packsSeen: [...new Set(listing.map((v) => v.quantityDescription))],
  };
}

export interface CartLine {
  sku: string;
  name: string;
  quantity: number;
}

export interface CartState {
  lines: CartLine[];
  // `other`: fees the vendor sums rather than itemises (Blinkit's handling,
  // late-night and small-cart charges come as one number). Null where the
  // vendor itemises everything, never zero.
  bill: { itemTotal: number | null; toPay: number | null; delivery: number | null; surge: number | null; smallCart: number | null; other: number | null; freeDeliveryAbove: number | null };
  // What the store says about delivering to this address now.
  serving: boolean;
  eta: string | null; // "23 Mins"
  message: string | null; // the vendor's own words when it can't deliver
  statuses: number[]; // the vendor's own status codes, for the log
}

const money = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

// What the store charges delivery below, in its own words.
//
// Instamart says it two different ways on the same field, and which one it
// uses depends on whether there is a cart:
//
//   empty cart: "<b>FREE DELIVERY</b> on orders above ₹199"   <- the line
//   filled:     "Add items worth ₹12 more for FREE DELIVERY"  <- the gap
//
// Those are not the same number and reading one as the other is worse than
// reading neither: taking the ₹12 for the threshold would have the app
// tell a household with ₹187 of shopping that they were already past it.
// So the wording decides. "above"/"over" is the line itself; "add"/"more"/
// "away" is what is left to spend, and the line is that plus what the cart
// already holds. Wording that says neither returns null, because a figure we
// cannot place is not a figure (design §9.3).
export function freeDeliveryAbove(comms: unknown, itemTotal: number | null = null): number | null {
  const nudges = (comms as { nudgeComms?: Record<string, { text?: unknown }> })?.nudgeComms;
  if (!nudges || typeof nudges !== 'object') return null;
  for (const nudge of Object.values(nudges)) {
    const raw = typeof nudge?.text === 'string' ? nudge.text : '';
    const text = raw.replace(/<[^>]*>/g, ' ');
    if (!/free\s*delivery/i.test(text)) continue;
    const amount = /₹\s*([\d,]+)/.exec(text);
    if (!amount) continue;
    const n = Number(amount[1].replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (/\b(above|over|upwards of)\b/i.test(text)) return n;
    // What is left to spend. Worth nothing without knowing what the cart
    // already holds, so it is dropped rather than guessed at.
    if (/\b(add|more|away|worth|left)\b/i.test(text)) return itemTotal === null ? null : Math.round(itemTotal + n);
  }
  return null;
}

// A cart answer (GET or POST /checkout/v2/cart) read into what we need.
//
// Serving: the answer carries several `serviceabilityDetails` (the store's,
// and one per shipment), and their status codes are not all the same even
// when the store is delivering. What is reliable is what the app shows a
// person: a delivery time ("40 Mins"), and an error message when it can't
// deliver. So it is serving when some part quotes a time and nothing says
// otherwise. The status codes are kept for the log.
export function readCartState(cartJson: unknown): CartState {
  const data = (cartJson as { data?: { data?: Record<string, unknown> } })?.data?.data ?? {};
  const lines: CartLine[] = ((data.items as Record<string, unknown>[]) ?? []).map((i) => ({
    sku: String(i.itemId ?? i.id ?? ''),
    name: String(i.displayName ?? i.name ?? ''),
    quantity: Number(i.quantity ?? 0),
  }));
  const bill = (data.bill ?? {}) as Record<string, unknown>;
  const details: { serviceabilityStatus?: number; sla?: string }[] = [];
  walk(data, (o) => {
    const d = o.serviceabilityDetails as { serviceabilityStatus?: number; sla?: string } | undefined;
    if (d) details.push(d);
  });
  const eta = details.find((d) => d.sla)?.sla ?? null;
  const message = typeof data.unavailableErrorMsg === 'string' && data.unavailableErrorMsg ? data.unavailableErrorMsg : null;
  const statuses = [...new Set(details.map((d) => d.serviceabilityStatus).filter((x): x is number => typeof x === 'number'))];
  return {
    lines,
    bill: {
      itemTotal: money(bill.itemTotal),
      toPay: money(bill.toPay),
      delivery: money(bill.deliveryCharges),
      surge: money(bill.surgeFee),
      smallCart: money(bill.smallCartCharges),
      other: null,
      freeDeliveryAbove: freeDeliveryAbove(data.comms, money(bill.itemTotal)),
    },
    serving: !message && (details.length === 0 || !!eta),
    eta,
    message,
    statuses,
  };
}
