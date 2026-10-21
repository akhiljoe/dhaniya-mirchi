// The product rules table (design §8): vendor product names → brand-agnostic
// canonical household items. Ported from spike/blinkit/normalize.ts, where it
// was tuned against two years of real Blinkit + Instamart orders (843 raw
// names → 355 items). THIS TABLE is the thing to edit — ordered, first match
// wins, specific patterns before generic ones.
//
// Classification, not arithmetic: quantities are the engine's job.

export type Category =
  | 'dairy' | 'produce' | 'bakery' | 'staple' | 'snacks' | 'beverages' | 'meat'
  | 'spices' | 'personal-care' | 'household' | 'pet' | 'frozen' | 'other' | 'exclude'
  // Food made to eat now (Zepto Cafe's puffs, samosas, chai): real spending,
  // never stock. Marked by the vendor itself, never guessed from a name.
  | 'prepared';
export type BaseUnit = 'ml' | 'g' | 'piece';
export type Rule = [RegExp, string, Category, BaseUnit];

export const RULES: Rule[] = [
  // --- non-grocery / not inventory ---
  [/portrait|photo print|single side|google pay card|gift card|bouquet|roses|daisies|led string|decorative light|usb hub|charging adapter|ball pen|glue stick|instant adhesive|hot water bag|voucher|greeting card|postcard|newspaper|\bflyer\b|\bcampaign\b|a project by|hajmola coasters|swalpa adjust|water bottle|nail enamel|gas lighter|t-?shirt|dog leash|\bbillfold\b|\bwallets?\b/i, 'excluded', 'exclude', 'piece'],
  // Dog treats before dairy and meat: their names carry food words ("Milk
  // Bone", "Chicken and Egg Biscuit", "Chicken Sausage for Dog").
  [/dog treats?|milk bone|\bdrools\b.*(biscuit|sausage|bone|treat|chew)|sausage for dogs?/i, 'dog treats', 'pet', 'g'],
  // Medicines before produce and drinks ("Cofsils Orange Lozenges", "Corex DX Syrup").
  [/paracetamol|(?<!dishwasher )\btablets?\b|lozenges?|cough|\bsyrup\b.*(relief|throat)|bandage|antiseptic/i, 'medicines', 'other', 'piece'],

  // --- drinks FIRST: their names carry ingredient words ("Pepsi Zero Sugar",
  //     "Pineapple Juice", "Jeera Masala Soda") that would otherwise land them
  //     in sugar / pineapple / spices.
  [/gatorade|prolyte|\bors\b|electral|energy drink/i, 'sports/ORS drink', 'beverages', 'ml'],
  [/juice|real fruit power|pressery|kombucha|mogu mogu|nimbooz|nimbu paani|maaza|frooti|mango.*drink/i, 'juice', 'beverages', 'ml'],
  [/7 ?up|limca|coca|pepsi|sprite|soft drink|\bsoda\b|\bcola\b/i, 'soft drink', 'beverages', 'ml'],

  // --- dairy (specific before milk) ---
  [/coconut milk/i, 'coconut milk', 'produce', 'ml'],
  [/milk bread/i, 'bread', 'bakery', 'g'],
  // ice cream before chocolate ("Belgian Dark Chocolate Ice Cream Tub") and butter/cream
  [/ice ?cream|butterscotch|kulfi|magnum|chocobar/i, 'ice cream', 'frozen', 'ml'],
  [/chocolate spread|hazelnut spread|nutella/i, 'chocolate spread', 'snacks', 'g'],
  // Before milk: a Milkybar is a chocolate bar with "milk" in its name, and
  // sat tenth in the household's list of milks.
  [/milkybar|milky bar|dairy milk/i, 'chocolate', 'snacks', 'g'],
  [/\bchocolate\b|\bcocoa\b|bournville|toblerone|ferrero rocher|\bkitkat\b|\blindt\b/i, 'chocolate', 'snacks', 'g'],
  [/paneer/i, 'paneer', 'dairy', 'g'],
  [/\bghee\b/i, 'ghee', 'dairy', 'ml'],
  [/\bbutter\b/i, 'butter', 'dairy', 'g'],
  [/cheddar|cheese|ricotta|mozzarella/i, 'cheese', 'dairy', 'g'],
  [/fresh cream|dairy cream|half & half cream|cooking cream/i, 'cream', 'dairy', 'ml'], // NOT bare \bcream\b — catches "full cream milk", "sour cream" chips
  [/yogurt|yoghurt/i, 'yogurt', 'dairy', 'g'],
  [/\bcurd\b/i, 'curd', 'dairy', 'g'],
  [/\bmilk\b/i, 'milk', 'dairy', 'ml'],
  [/\beggs?\b/i, 'eggs', 'dairy', 'piece'],

  // --- bakery / staples ---
  [/\bbread\b/i, 'bread', 'bakery', 'g'],
  [/\bbuns?\b|\bpav\b/i, 'buns & pav', 'bakery', 'g'],
  // Rusk before cardamom: "Parle Elaichi Rusk" is rusk, not a spice.
  [/\brusk\b/i, 'rusk', 'bakery', 'g'],
  [/idli.*batter|dosa batter/i, 'idli dosa batter', 'staple', 'g'],
  [/basmati|jasmine rice|\brice\b/i, 'rice', 'staple', 'g'],
  [/\brajma\b/i, 'rajma', 'staple', 'g'],
  [/corn flour|corn starch/i, 'corn flour', 'staple', 'g'],
  [/\bsugar\b/i, 'sugar', 'staple', 'g'],
  [/olive oil/i, 'olive oil', 'staple', 'ml'],
  [/coconut oil/i, 'coconut oil', 'staple', 'ml'],
  [/mustard oil/i, 'mustard oil', 'staple', 'ml'],
  [/vegetable oil|sunflower oil|refined oil|rice bran oil/i, 'cooking oil', 'staple', 'ml'],

  // --- produce (specific before generic) ---
  [/ginger garlic paste/i, 'ginger garlic paste', 'spices', 'g'],
  // Snacks made of a vegetable are not the vegetable. These sit above produce
  // because the rules are read in order and "Potato Wafers" would otherwise
  // match \bpotato\b - which put a packet of crisps in the household's cart
  // when the list said potatoes (seen 2026-09-21).
  [/\b(potato|banana|tapioca|plantain|jackfruit|beetroot)\s*(chips|wafers|crisps)\b/i, 'chips & namkeen', 'snacks', 'g'],
  [/sweet potato/i, 'sweet potato', 'produce', 'g'],
  [/baby potato|\bpotato\b/i, 'potato', 'produce', 'g'],
  [/\bcarrot\b/i, 'carrot', 'produce', 'g'],
  [/\btomato\b/i, 'tomato', 'produce', 'g'],
  // Spring onion before onion: a different vegetable, bought on its own rhythm.
  [/spring onion|hasiru eerulli/i, 'spring onion', 'produce', 'g'],
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
  [/french.*beans|green beans|haricot beans|bili hurul/i, 'french beans', 'produce', 'g'],
  [/lettuce/i, 'lettuce', 'produce', 'g'],
  [/cauliflower/i, 'cauliflower', 'produce', 'g'],
  [/beetroot/i, 'beetroot', 'produce', 'g'],
  [/green peas|frozen.*peas/i, 'green peas', 'produce', 'g'],
  [/zucchini/i, 'zucchini', 'produce', 'g'],
  [/bitter gourd/i, 'bitter gourd', 'produce', 'g'],
  [/bottle gourd/i, 'bottle gourd', 'produce', 'g'],
  [/ridge gourd/i, 'ridge gourd', 'produce', 'g'],
  [/brinjal|baingan|eggplant/i, 'brinjal', 'produce', 'g'],
  [/\bbasil\b/i, 'basil', 'produce', 'g'],
  [/avocado/i, 'avocado', 'produce', 'g'],
  [/\bapple\b/i, 'apple', 'produce', 'g'],
  [/\bpear\b/i, 'pear', 'produce', 'g'],
  [/pineapple/i, 'pineapple', 'produce', 'g'],
  [/pomegranate/i, 'pomegranate', 'produce', 'g'],
  [/guava/i, 'guava', 'produce', 'g'],
  // Mango the fruit; the powder (amchur) is a spice and mango drinks are juice.
  [/\bmango\b(?!.*(powder|amchur|pickle))/i, 'mango', 'produce', 'g'],
  [/nagpur orange|kittale|kinnow|mandarin/i, 'orange', 'produce', 'g'],
  [/litchi|lychee/i, 'litchi', 'produce', 'g'],
  [/grated coconut|\bcoconut\b/i, 'coconut', 'produce', 'g'],
  [/sugarcane/i, 'sugarcane', 'produce', 'g'],
  [/cardamom|elaichi/i, 'cardamom', 'spices', 'g'],

  // --- prepared / flavoured foods (BEFORE raw meat, so "chicken noodles",
  //     "chicken dog food", "chicken masala cubes" don't become 'chicken') ---
  [/dog treat/i, 'dog treats', 'pet', 'g'],
  [/dog food|dog wet food|for dogs|pedigree|kennel kitchen|jerhigh/i, 'dog food', 'pet', 'g'],
  [/instant noodle|ramen|wai wai|buldak|shin ramyun|maggi.*noodle/i, 'instant noodles', 'staple', 'g'],
  [/magic cubes?|masala cubes?/i, 'seasoning cubes', 'spices', 'g'],

  // --- meat ---
  [/salami/i, 'salami', 'meat', 'g'],
  [/\bbacon\b/i, 'bacon', 'meat', 'g'],
  [/sausage|frankfurter|hotdog|hot dog/i, 'sausage', 'meat', 'g'],
  [/keema|mince/i, 'chicken mince', 'meat', 'g'],
  [/chicken/i, 'chicken', 'meat', 'g'],
  [/mutton|\blamb\b/i, 'mutton', 'meat', 'g'],
  [/\bfish\b/i, 'fish', 'meat', 'g'],

  // --- snacks / sweets ---
  [/potato chips|\bchips\b|kurkure|bhujia|\bsev\b|namkeen|soya sticks/i, 'chips & namkeen', 'snacks', 'g'],
  [/popcorn/i, 'popcorn', 'snacks', 'g'],
  [/wafer|biscuit|cookies|marie/i, 'biscuits', 'snacks', 'g'],
  [/chikki/i, 'chikki', 'snacks', 'g'],
  [/protein bar/i, 'protein bar', 'snacks', 'g'],

  // --- pantry / instant ---
  [/soy sauce|vinegar|hot sauce|chow/i, 'sauces', 'spices', 'ml'],
  [/food colour|vanilla essence|baking/i, 'baking supplies', 'spices', 'ml'],
  [/black pepper|pepper powder|peppercorn/i, 'black pepper', 'spices', 'g'],
  [/tamarind|imli/i, 'tamarind', 'spices', 'g'],
  [/masala|turmeric|\bhing\b|asafoetida|garam|jeera|cumin|pattar|dagad|kasuri methi|amchur/i, 'spices & masala', 'spices', 'g'], // \bhing\b: not "Smoothing"

  // --- staples / pantry (brand-agnostic) ---
  [/\batta\b|whole wheat flour/i, 'atta', 'staple', 'g'], // before maida: atta names say "0% Maida"
  [/(?<!no )\bmaida\b/i, 'maida', 'staple', 'g'], // not "No Maida Choco Cereal"
  [/\bsalt\b|\bnamak\b/i, 'salt', 'staple', 'g'],
  [/\bpapad\b/i, 'papad', 'snacks', 'g'], // before dal: "Lijjat Moong Papad"
  [/\bdal\b|masoor|toor|arhar/i, 'dal', 'staple', 'g'],
  [/besan|gram flour/i, 'besan', 'staple', 'g'],
  [/\bsuji\b|\brawa\b|semolina/i, 'suji', 'staple', 'g'],
  [/pasta|spaghetti|penne|fusilli|macaroni/i, 'pasta', 'staple', 'g'],
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
  [/face ?wash/i, 'face wash', 'personal-care', 'ml'],
  [/moisturi[sz]er/i, 'moisturizer', 'personal-care', 'ml'],
  [/(?<!dish )\bsoap\b/i, 'soap', 'personal-care', 'piece'],
  [/sanitary pad|whisper|stayfree/i, 'sanitary pads', 'personal-care', 'piece'],
  [/condom/i, 'condoms', 'personal-care', 'piece'],
  [/baby wipes/i, 'baby wipes', 'personal-care', 'piece'],

  // --- household ---
  [/toilet roll|toilet paper/i, 'toilet paper', 'household', 'piece'],
  [/kitchen towel|kitchen roll|tissue|pulls/i, 'tissue', 'household', 'piece'],
  [/detergent|top load|front load|surf excel|\bariel\b/i, 'detergent', 'household', 'ml'],
  [/toilet cleaner|harpic/i, 'toilet cleaner', 'household', 'ml'],
  [/glass.*cleaner|\bcolin\b/i, 'glass cleaner', 'household', 'ml'],
  [/cleaning cloth|pocha|duster/i, 'cleaning cloth', 'household', 'piece'],
  [/zip ?(&|and)? ?lock|storage bags|ziploc/i, 'storage bags', 'household', 'piece'],
  [/fabric conditioner|after wash/i, 'fabric conditioner', 'household', 'ml'],
  [/dishwash|dish ?soap|scrubber|scrub pad|sponge|scotch brite/i, 'dishwash & scrub', 'household', 'piece'],
  [/broom|jhadu|\bmop\b/i, 'broom/mop', 'household', 'piece'],
  [/air freshener|\baer\b/i, 'air freshener', 'household', 'ml'],
  [/cling wrap|cling film|aluminium foil|foil/i, 'cling film / foil', 'household', 'piece'],
  [/disposable spoon|disposable|cutlery/i, 'disposables', 'household', 'piece'],
  [/ice cubes?/i, 'ice cubes', 'household', 'g'],
];

// Emoji per canonical item; anything not listed takes its category's.
export const ITEM_EMOJI: Record<string, string> = {
  milk: '🥛', curd: '🥣', yogurt: '🥣', paneer: '🧀', cheese: '🧀', butter: '🧈', ghee: '🧈', cream: '🥛',
  eggs: '🥚', bread: '🍞', rusk: '🍞', rice: '🍚', atta: '🌾', maida: '🌾', sugar: '🧂', salt: '🧂',
  'ice cream': '🍨', chocolate: '🍫', 'chocolate spread': '🍫', 'coconut milk': '🥥', coconut: '🥥',
  potato: '🥔', 'sweet potato': '🍠', carrot: '🥕', tomato: '🍅', onion: '🧅', garlic: '🧄', ginger: '🫚',
  coriander: '🌿', 'curry leaves': '🌿', mint: '🌿', spinach: '🥬', lettuce: '🥬', 'bell pepper': '🫑',
  'green chilli': '🌶️', 'chilli powder': '🌶️', lemon: '🍋', banana: '🍌', apple: '🍎', pear: '🍐',
  pineapple: '🍍', avocado: '🥑', cucumber: '🥒', mushroom: '🍄', broccoli: '🥦', cauliflower: '🥦',
  'green peas': '🫛', 'french beans': '🫛', chicken: '🍗', 'chicken mince': '🍗', mutton: '🍖', fish: '🐟',
  salami: '🥓', bacon: '🥓', sausage: '🌭', 'instant noodles': '🍜', biscuits: '🍪', 'chips & namkeen': '🥨',
  popcorn: '🍿', tea: '🍵', 'instant coffee': '☕', juice: '🧃', 'soft drink': '🥤', 'drinking water': '💧',
  'dog food': '🐶', 'dog treats': '🦴', toothpaste: '🪥', toothbrush: '🪥', shampoo: '🧴', 'hand wash': '🧴',
  'toilet paper': '🧻', tissue: '🧻', detergent: '🧺', 'dishwash & scrub': '🧽', 'garbage bags': '🗑️',
  honey: '🍯', almonds: '🥜', cashews: '🥜', walnuts: '🥜', dates: '🌴',
  mango: '🥭', orange: '🍊', litchi: '🍒', brinjal: '🍆', 'spring onion': '🧅', dal: '🫘', besan: '🌾', suji: '🌾',
  pasta: '🍝', 'buns & pav': '🍞', 'black pepper': '🧂', medicines: '💊', soap: '🧼', 'mustard oil': '🫙', 'cooking oil': '🫙',
};

export const CATEGORY_EMOJI: Record<Category, string> = {
  dairy: '🥛', produce: '🥬', bakery: '🍞', staple: '🌾', snacks: '🍪', beverages: '🧃', meat: '🍗',
  spices: '🧂', 'personal-care': '🧴', household: '🧽', pet: '🐾', frozen: '🧊', other: '🛒', exclude: '📦', prepared: '🍱',
};

// How a category is named on screen.
export const CATEGORY_LABEL: Record<Category, string> = {
  dairy: 'Dairy & eggs', produce: 'Fruits & vegetables', bakery: 'Bakery', staple: 'Pantry',
  snacks: 'Snacks', beverages: 'Drinks', meat: 'Meat & fish', spices: 'Spices & sauces',
  'personal-care': 'Personal care', household: 'Household', pet: 'Pet', frozen: 'Frozen', other: 'Other',
  exclude: 'Not groceries', prepared: 'Ready to eat',
};

// The one item every vendor-marked ready-to-eat line becomes.
export const PREPARED_ITEM = 'café food';

// The fallback name keeps this many leading words of the product name.
export const FALLBACK_NAME_WORDS = 4;
