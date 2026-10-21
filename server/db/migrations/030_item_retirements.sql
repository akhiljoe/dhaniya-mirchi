-- "We don't buy this any more." The one control a stranger asked for first:
-- the app kept predicting things it should have known to stop predicting - a
-- wallet bought once, pet pads from a dog that has gone, rusk nobody eats -
-- and offered no way to say so. A retired item is left out of the stock
-- list, the running-low list and Insights' "not bought lately", and is
-- shown on the Household page with a way back.
--
-- Per household, by canonical item (the catalog's name, e.g. "pet pads"), so
-- it survives a recompute of everything else: this is a fact the household
-- stated, not a projection (design §11 rule 2).
create table if not exists item_retirements (
  household_id uuid not null references households(id) on delete cascade,
  item         text not null,
  retired_at   timestamptz not null default now(),
  retired_by   text references users(id) on delete set null,
  primary key (household_id, item)
);
