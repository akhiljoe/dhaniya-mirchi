-- Household facts (design §9.12): what the household tells us that changes how
-- fast things are used — who lives here, guests, pets, regular use, time
-- away. Dated, kept with the person's own words, and append-only: a change is
-- a new fact; withdrawing one is recorded here, never a delete. The engine
-- reads the facts not withdrawn, like it reads orders (design §11 rule 2).
create table household_facts (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  kind          text not null check (kind in ('people', 'guests', 'pets', 'regular_use', 'away')),
  -- The household's local dates. ends_on is the last day it holds; null =
  -- open (people, pets, regular use until changed; away until back).
  starts_on     date not null,
  ends_on       date null,
  details       jsonb not null,
  -- The person's own words, when they gave any (a form's note, or the text
  -- the AI read, design §7.8).
  said          text null check (said is null or length(said) <= 1000),
  source        text not null check (source in ('form', 'ai', 'suggestion')),
  created_by    text null references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  withdrawn_at  timestamptz null,
  withdrawn_by  text null references users (id) on delete set null,
  check (ends_on is null or ends_on >= starts_on)
);

create index household_facts_household_idx on household_facts (household_id, starts_on) where withdrawn_at is null;
