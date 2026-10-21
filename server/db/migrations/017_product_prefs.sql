-- Which product the household wants for each item, in order (design §19
-- Ordering, "which product"): "milk" → Nandini first, then Amul, then
-- Akshayakalpa; never Arokya. Add to cart tries them in this order. With no
-- row, the order is the household's own buying (most bought lately first),
-- computed on the page; a row exists only once someone changes it.
--
-- Products are named as the grocery app names them ("Nandini Pasteurised
-- Toned Milk"), matched case- and space-insensitively. Household-wide: every
-- member sees and changes the same order.
create table item_product_prefs (
  household_id  uuid not null references households (id) on delete cascade,
  -- The canonical item (catalog rules.ts), e.g. 'milk'.
  item          text not null check (length(item) between 1 and 60),
  -- Product names, first choice first.
  ranked        jsonb not null default '[]'::jsonb check (jsonb_typeof(ranked) = 'array'),
  -- Products never to add.
  blocked       jsonb not null default '[]'::jsonb check (jsonb_typeof(blocked) = 'array'),
  updated_by    text null references users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (household_id, item)
);
