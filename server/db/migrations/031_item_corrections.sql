-- "I have more" / "Already finished" / "Not sure" on an item, said by the
-- household. These were page state and vanished on reload, so a household
-- that corrected the app on Monday was corrected back by Tuesday.
--
-- One row per item per household: the latest word wins. A correction holds
-- until the item is next bought after it was said (the page compares
-- said_at to the item's last purchase), and then the engine takes over
-- again. That rule lives in the page, not here: this is the stated fact,
-- not the projection (design §11 rule 2).
create table if not exists item_corrections (
  household_id uuid not null references households(id) on delete cascade,
  item         text not null,
  kind         text not null check (kind in ('more', 'finished', 'unsure')),
  said_at      timestamptz not null default now(),
  said_by      text references users(id) on delete set null,
  primary key (household_id, item)
);
