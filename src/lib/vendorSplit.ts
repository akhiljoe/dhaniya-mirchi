// Which app each thing on the list actually comes from.
//
// The household hit this by sending a list and finding items missing: they
// buy coriander on Blinkit and never on Instamart, so the Instamart cart
// could not have them. Nothing had said so beforehand - the fill found out
// at the vendor, one item at a time.
//
// It is answerable from the orders alone, before anything is sent: every
// product carries the apps it has been bought on (lib/products.ts). A thing
// never once bought on the app the cart goes to is a thing that app probably
// does not stock for this household, and saying so costs no vendor call.
//
// This is evidence, not a catalogue: "never bought there" is not "not sold
// there". So the words are about the household's own buying, and the item
// still goes in the cart if they want it - it is a warning, never a block.
import type { Product } from './products';

export interface SplitLine {
  item: string; // canonical item name
  name: string; // as shown
  product: Product;
}

export interface VendorSplit {
  // Things the household has bought on the app this cart goes to.
  here: SplitLine[];
  // Things they have only ever bought elsewhere, grouped by the app.
  elsewhere: { vendor: string; lines: SplitLine[] }[];
}

// `cartVendor` is the app the cart is being filled on. A product with no
// vendors recorded at all (nothing imported yet) counts as "here": an empty
// record is not evidence of absence.
export function splitByVendor(lines: SplitLine[], cartVendor: string): VendorSplit {
  const here: SplitLine[] = [];
  const byVendor = new Map<string, SplitLine[]>();
  for (const line of lines) {
    const vendors = line.product.vendors;
    if (!vendors.length || vendors.includes(cartVendor)) {
      here.push(line);
      continue;
    }
    // Where they do buy it: the app named most often is good enough, and
    // there is almost always only one.
    const vendor = vendors[0];
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), line]);
  }
  return {
    here,
    elsewhere: [...byVendor.entries()]
      .map(([vendor, lines]) => ({ vendor, lines }))
      .sort((a, b) => b.lines.length - a.lines.length),
  };
}

// "2 of these you only buy on Blinkit." Null when everything on the list is
// bought on the app the cart goes to, which is the ordinary case and needs
// no sentence.
export function splitNote(split: VendorSplit, nameOf: (vendor: string) => string): string | null {
  if (!split.elsewhere.length) return null;
  const total = split.elsewhere.reduce((n, g) => n + g.lines.length, 0);
  const where = split.elsewhere.map((g) => nameOf(g.vendor)).join(' and ');
  return `${total} of these you only buy on ${where}.`;
}
