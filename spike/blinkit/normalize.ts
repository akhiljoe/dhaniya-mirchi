// Phase 0 spike — product normalization.
//
// Collapses 800+ raw product strings into brand-agnostic canonical items via an
// ORDERED rules table (first match wins). Recurring staples are mapped
// deliberately; the long tail of one-offs falls to a strip-based fallback. The
// RULES table is the thing to edit — not the 843-row output.
//
//   npm run normalize
//
// Writes mapping.json: [{ raw, canonical, category, baseUnit, count }].
// Non-grocery noise (print orders, gift cards, gadgets) → category 'exclude',
// which the engine ignores.
//
import { readFileSync, writeFileSync } from 'node:fs';

type Cat = 'dairy' | 'produce' | 'bakery' | 'staple' | 'snacks' | 'beverages'
  | 'meat' | 'spices' | 'personal-care' | 'household' | 'pet' | 'frozen' | 'other' | 'exclude';
type Unit = 'ml' | 'g' | 'piece';
type Rule = [RegExp, string, Cat, Unit];

// ORDER MATTERS — specific patterns before generic ones.
const RULES: Rule[] = [
  // --- non-grocery / not inventory ---
  [/portrait|photo print|single side|google pay card|gift card|bouquet|roses|daisies|led string|decorative light|usb hub|charging adapter|ball pen|glue stick|instant adhesive|hot water bag/i, 'excluded', 'exclude', 'piece'],

  // --- drinks FIRST: their names carry ingredient words ("Pepsi Zero Sugar",
  //     "Pineapple Juice", "Jeera Masala Soda") that would otherwise land them
  //     in sugar / pineapple / spices. Caught by analyze's unit-mismatch report.
  [/gatorade|prolyte|\bors\b|electral|energy drink/i, 'sports/ORS drink', 'beverages', 'ml'],
  [/juice|pressery|kombucha|mogu mogu|nimbooz|nimbu paani|maaza|frooti|mango.*drink/i, 'juice', 'beverages', 'ml'],
  [/7 ?up|limca|coca|pepsi|sprite|soft drink|\bsoda\b|\bcola\b/i, 'soft drink', 'beverages', 'ml'],

  // --- dairy (specific before milk) ---
  [/coconut milk/i, 'coconut milk', 'produce', 'ml'],
  [/milk bread/i, 'bread', 'bakery', 'g'],
  // ice cream before chocolate ("Belgian Dark Chocolate Ice Cream Tub") and butter/cream
  [/ice ?cream|butterscotch|kulfi|magnum|chocobar/i, 'ice cream', 'frozen', 'ml'],
  [/chocolate spread|hazelnut spread|nutella/i, 'chocolate spread', 'snacks', 'g'],
  [/\bchocolate\b|\bcocoa\b|bournville|toblerone|ferrero rocher|\bkitkat\b|\blindt\b/i, 'chocolate', 'snacks', 'g'],
  [/paneer/i, 'paneer', 'dairy', 'g'],
  [/\bghee\b/i, 'ghee', 'dairy', 'ml'],
  [/\bbutter\b/i, 'butter', 'dairy', 'g'],
  [/cheddar|cheese|ricotta/i, 'cheese', 'dairy', 'g'],
  [/fresh cream/i, 'cream', 'dairy', 'ml'], // NOT bare \bcream\b — catches "full cream milk", "sour cream" chips
  [/yogurt|yoghurt/i, 'yogurt', 'dairy', 'g'],
  [/\bcurd\b/i, 'curd', 'dairy', 'g'],
  [/\bmilk\b/i, 'milk', 'dairy', 'ml'],
  [/\beggs?\b/i, 'eggs', 'dairy', 'piece'],

  // --- bakery / staples ---
  [/\bbread\b/i, 'bread', 'bakery', 'g'],
  [/idli.*dosa batter|dosa batter/i, 'idli dosa batter', 'staple', 'g'],
  [/basmati|jasmine rice|\brice\b/i, 'rice', 'staple', 'g'],
  [/\brajma\b/i, 'rajma', 'staple', 'g'],
  [/corn flour|corn starch/i, 'corn flour', 'staple', 'g'],
  [/\bsugar\b/i, 'sugar', 'staple', 'g'],
  [/olive oil/i, 'olive oil', 'staple', 'ml'],
  [/coconut oil/i, 'coconut oil', 'staple', 'ml'],

  // --- produce (specific before generic) ---
  [/ginger garlic paste/i, 'ginger garlic paste', 'spices', 'g'],
  [/sweet potato/i, 'sweet potato', 'produce', 'g'],
  [/baby potato|\bpotato\b/i, 'potato', 'produce', 'g'],
  [/\bcarrot\b/i, 'carrot', 'produce', 'g'],
  [/\btomato\b/i, 'tomato', 'produce', 'g'],
  [/sambhar onion|\bonion\b/i, 'onion', 'produce', 'g'],
  [/curry leaves|kadi patta|curry patta/i, 'curry leaves', 'produce', 'g'],
  [/coriander/i, 'coriander', 'produce', 'g'],
  [/\bginger\b/i, 'ginger', 'produce', 'g'],
  [/\bgarlic\b/i, 'garlic', 'produce', 'g'],
  [/mint leaves|\bmint\b/i, 'mint', 'produce', 'g'],
  [/rosemary/i, 'rosemary', 'produce', 'g'],
  [/spinach|palak/i, 'spinach', 'produce', 'g'],
  [/capsicum|bell pepper/i, 'bell pepper', 'produce', 'g'],
  [/chilli powder|red chilli|paprika/i, 'chilli powder', 'spices', 'g'],
  [/green chilli|\bchilli\b/i, 'green chilli', 'produce', 'g'],
  [/\blemon\b/i, 'lemon', 'produce', 'g'],
  [/\bbanana\b/i, 'banana', 'produce', 'g'],
  [/pumpkin/i, 'pumpkin', 'produce', 'g'],
  [/cucumber/i, 'cucumber', 'produce', 'g'],
  [/mushroom/i, 'mushroom', 'produce', 'g'],
  [/broccoli/i, 'broccoli', 'produce', 'g'],
  [/lady'?s? ?finger|okra|bhindi|bendekaayi/i, 'lady finger', 'produce', 'g'],
  [/french.*beans|green beans|bili hurul/i, 'french beans', 'produce', 'g'],
  [/lettuce/i, 'lettuce', 'produce', 'g'],
  [/cauliflower/i, 'cauliflower', 'produce', 'g'],
  [/beetroot/i, 'beetroot', 'produce', 'g'],
  [/green peas|frozen.*peas/i, 'green peas', 'produce', 'g'],
  [/zucchini/i, 'zucchini', 'produce', 'g'],
  [/bitter gourd/i, 'bitter gourd', 'produce', 'g'],
  [/avocado/i, 'avocado', 'produce', 'g'],
  [/\bapple\b/i, 'apple', 'produce', 'g'],
  [/\bpear\b/i, 'pear', 'produce', 'g'],
  [/pineapple/i, 'pineapple', 'produce', 'g'],
  [/pomegranate/i, 'pomegranate', 'produce', 'g'],
  [/guava/i, 'guava', 'produce', 'g'],
  [/grated coconut|\bcoconut\b/i, 'coconut', 'produce', 'g'],
  [/sugarcane/i, 'sugarcane', 'produce', 'g'],
  [/cardamom|elaichi/i, 'cardamom', 'spices', 'g'],

  // --- prepared / flavoured foods (BEFORE raw meat, so "chicken noodles",
  //     "chicken dog food", "chicken masala cubes" don't become 'chicken') ---
  [/dog treat/i, 'dog treats', 'pet', 'g'],
  [/dog food|dog wet food|pedigree|kennel kitchen/i, 'dog food', 'pet', 'g'],
  [/instant noodle|ramen|wai wai|buldak|shin ramyun|maggi.*noodle/i, 'instant noodles', 'staple', 'g'],
  [/magic cubes?|masala cubes?/i, 'seasoning cubes', 'spices', 'g'],

  // --- meat ---
  [/salami/i, 'salami', 'meat', 'g'],
  [/\bbacon\b/i, 'bacon', 'meat', 'g'],
  [/sausage|frankfurter|hotdog|hot dog/i, 'sausage', 'meat', 'g'],
  [/keema|mince/i, 'chicken mince', 'meat', 'g'],
  [/chicken/i, 'chicken', 'meat', 'g'],
  [/mutton/i, 'mutton', 'meat', 'g'],
  [/\bfish\b/i, 'fish', 'meat', 'g'],

  // --- snacks / sweets ---
  [/potato chips|\bchips\b|kurkure|bhujia|\bsev\b|namkeen/i, 'chips & namkeen', 'snacks', 'g'],
  [/popcorn/i, 'popcorn', 'snacks', 'g'],
  [/chocolate spread|hazelnut spread|nutella/i, 'chocolate spread', 'snacks', 'g'],
  [/wafer|biscuit|cookies|marie/i, 'biscuits', 'snacks', 'g'],
  [/ice cream|kulfi|magnum/i, 'ice cream', 'frozen', 'ml'],

  // --- pantry / instant ---
  [/instant noodle|ramen|\bmaggi\b.*noodle|wai wai|buldak|shin ramyun/i, 'instant noodles', 'staple', 'g'],
  [/magic cubes|masala cubes/i, 'seasoning cubes', 'spices', 'g'],
  [/soy sauce|vinegar|hot sauce|chow/i, 'sauces', 'spices', 'ml'],
  [/food colour|vanilla essence|baking/i, 'baking supplies', 'spices', 'ml'],
  [/masala|turmeric|\bhing\b|asafoetida|garam|jeera|cumin|pattar|dagad/i, 'spices & masala', 'spices', 'g'], // \bhing\b: not "Smoothing"

  // --- staples / pantry added with the Instamart merge (brand-agnostic) ---
  [/\brusk\b/i, 'rusk', 'bakery', 'g'],
  [/\batta\b|whole wheat flour/i, 'atta', 'staple', 'g'], // before maida: atta names say "0% Maida"
  [/(?<!no )\bmaida\b/i, 'maida', 'staple', 'g'], // not "No Maida Choco Cereal"
  [/\bsalt\b|\bnamak\b/i, 'salt', 'staple', 'g'],
  [/\bpapad\b/i, 'papad', 'snacks', 'g'],
  [/\bhoney\b/i, 'honey', 'staple', 'g'],
  [/almond|badam/i, 'almonds', 'staple', 'g'],
  [/cashew|kaju/i, 'cashews', 'staple', 'g'],
  [/walnut|akhrot/i, 'walnuts', 'staple', 'g'],
  [/pistachio|pista/i, 'pistachios', 'staple', 'g'],
  [/raisin|munakka|kishmish/i, 'raisins', 'staple', 'g'],
  [/\bdates\b|khajur/i, 'dates', 'staple', 'g'],
  [/anjeer|\bfigs?\b/i, 'figs', 'staple', 'g'],
  [/dried .*berr|berr.*dried|seeds? mix|nut.*seeds/i, 'dry fruits & nuts', 'staple', 'g'],
  [/^(?!.*(mask|strainer|kettle|infuser|\bcup)).*\btea\b(?!.*(tree|light))/i, 'tea', 'beverages', 'g'],
  [/garbage bag|trash bag|dustbin bag/i, 'garbage bags', 'household', 'piece'],
  [/floor cleaner|nimyle|lizol/i, 'floor cleaner', 'household', 'ml'],
  [/training pad|pee pad|puppy pad/i, 'pet pads', 'pet', 'piece'],

  // --- beverages ---
  [/instant coffee|nescafe|davidoff/i, 'instant coffee', 'beverages', 'g'],
  [/horlicks|malt drink|bournvita/i, 'malt drink', 'beverages', 'g'],
  [/gatorade|prolyte|\bors\b|electral/i, 'sports/ORS drink', 'beverages', 'ml'],
  [/juice|pressery|mogu mogu|nimbooz|nimbu paani|maaza|frooti|mango.*drink/i, 'juice', 'beverages', 'ml'],
  [/7up|limca|coca|pepsi|sprite|soft drink|soda/i, 'soft drink', 'beverages', 'ml'],
  [/packaged water|bisleri|kinley|mineral water/i, 'drinking water', 'beverages', 'ml'],

  // --- personal care ---
  [/toothpaste/i, 'toothpaste', 'personal-care', 'g'],
  [/toothbrush/i, 'toothbrush', 'personal-care', 'piece'],
  [/shampoo/i, 'shampoo', 'personal-care', 'ml'],
  [/conditioner(?!.*fabric)|hair mask/i, 'hair conditioner', 'personal-care', 'ml'],
  [/shower gel|body wash/i, 'shower gel', 'personal-care', 'ml'],
  [/hand wash|handwash/i, 'hand wash', 'personal-care', 'ml'],
  [/face serum|niacinamide|vitamin c.*serum/i, 'face serum', 'personal-care', 'ml'],
  [/sheet mask|face mask|charcoal mask/i, 'face mask', 'personal-care', 'piece'],
  [/loofah/i, 'loofah', 'personal-care', 'piece'],
  [/sanitary pad|whisper|stayfree/i, 'sanitary pads', 'personal-care', 'piece'],
  [/condom/i, 'condoms', 'personal-care', 'piece'],
  [/baby wipes/i, 'baby wipes', 'personal-care', 'piece'],

  // --- household ---
  [/toilet roll|toilet paper/i, 'toilet paper', 'household', 'piece'],
  [/kitchen towel|kitchen roll|tissue|pulls/i, 'tissue', 'household', 'piece'],
  [/detergent/i, 'detergent', 'household', 'ml'],
  [/fabric conditioner|after wash/i, 'fabric conditioner', 'household', 'ml'],
  [/dishwash|scrubber|scrub pad|sponge|scotch brite/i, 'dishwash & scrub', 'household', 'piece'],
  [/broom|jhadu|\bmop\b/i, 'broom/mop', 'household', 'piece'],
  [/air freshener|\baer\b/i, 'air freshener', 'household', 'ml'],
  [/cling wrap|cling film|aluminium foil|foil/i, 'cling film / foil', 'household', 'piece'],
  [/disposable spoon|disposable|cutlery/i, 'disposables', 'household', 'piece'],
  [/ice cubes?/i, 'ice cubes', 'household', 'g'],

  // --- pet ---
  [/dog treat|dog.*treat/i, 'dog treats', 'pet', 'g'],
  [/dog food|dog wet food|pedigree|kennel kitchen|jerhigh/i, 'dog food', 'pet', 'g'],
];

interface Distinct { name: string; count: number; units: Record<string, number> }
interface Mapping { raw: string; canonical: string; category: Cat; baseUnit: Unit; count: number }

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
    .slice(0, 4)
    .join(' ');
}

function classify(name: string, topUnit: string): { canonical: string; category: Cat; baseUnit: Unit } {
  for (const [re, canonical, category, baseUnit] of RULES) {
    if (re.test(name)) return { canonical, category, baseUnit };
  }
  const unit: Unit = /ml|l$/.test(topUnit) ? 'ml' : /piece|pcs/.test(topUnit) ? 'piece' : 'g';
  return { canonical: stripFallback(name) || name.toLowerCase(), category: 'other', baseUnit: unit };
}

function main() {
  const distinct: Distinct[] = JSON.parse(readFileSync('distinct_products.json', 'utf8'));
  const mapping: Mapping[] = distinct.map((d) => {
    const topUnit = Object.entries(d.units).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const { canonical, category, baseUnit } = classify(d.name, topUnit);
    return { raw: d.name, canonical, category, baseUnit, count: d.count };
  });
  mapping.sort((a, b) => b.count - a.count);
  writeFileSync('mapping.json', JSON.stringify(mapping, null, 2));

  // Report: merged canonical items by total purchase count.
  const byCanon = new Map<string, { count: number; category: Cat; raws: Set<string> }>();
  for (const m of mapping) {
    const e = byCanon.get(m.canonical) ?? { count: 0, category: m.category, raws: new Set() };
    e.count += m.count;
    e.raws.add(m.raw);
    byCanon.set(m.canonical, e);
  }
  const ranked = [...byCanon.entries()].sort((a, b) => b[1].count - a[1].count);
  const excluded = mapping.filter((m) => m.category === 'exclude');
  const fellThrough = mapping.filter((m) => m.category === 'other' && m.count >= 3);

  console.log(`raw products: ${mapping.length} → canonical items: ${byCanon.size}`);
  console.log(`excluded (non-grocery): ${excluded.length} raw strings`);
  console.log(`\ntop 40 canonical items (by total buys, [n raw strings merged]):`);
  for (const [canon, e] of ranked.slice(0, 40)) {
    console.log(`  ${String(e.count).padStart(4)}  ${canon.padEnd(24)} ${('[' + e.raws.size + ']').padStart(5)}  ${e.category}`);
  }
  if (fellThrough.length) {
    console.log(`\nrecurring items (count>=3) that hit the FALLBACK — candidates for a rule:`);
    for (const m of fellThrough.slice(0, 40)) console.log(`  ${String(m.count).padStart(3)}  ${m.canonical}   <= ${m.raw}`);
  }
  console.log('\nsaved mapping.json — edit RULES in normalize.ts and re-run to refine.');
}

main();
