-- Households and membership (design §10.1). Every household-scoped row hangs
-- off a household, and every api route checks membership (design §14.3) —
-- there is no row-level security.

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 60),
  -- Required: depletion dates, "this week" and quiet hours all need it.
  timezone    text not null,
  created_at  timestamptz not null default now()
);

create table household_members (
  household_id  uuid not null references households (id) on delete cascade,
  user_id       text not null references users (id) on delete cascade,
  role          text not null check (role in ('owner', 'member')),
  joined_at     timestamptz not null default now(),
  primary key (household_id, user_id),
  -- v1: one household per user.
  unique (user_id)
);
