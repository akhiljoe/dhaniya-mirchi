-- The AI layer (design §7.8, §19 "Bring your own key"). The model only reads
-- a household's words into proposed facts (§9.12); code does the rest.

-- One piece of text to read, or a key to check. The api queues it; the worker
-- (which alone can open a household's sealed key, §14.3) calls the model.
create table ai_requests (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  user_id       text null references users (id) on delete set null,
  purpose       text not null check (purpose in ('parse_facts', 'check_key')),
  -- What the person wrote. Kept for the proposal's "your words"; the facts
  -- they confirm carry it too.
  text          text null check (text is null or length(text) <= 1000),
  -- The household's item names and units, sent by the page (the catalog lives
  -- there), so "tea milk" can map to `milk` and amounts to its unit.
  context       jsonb null,
  status       text not null check (status in ('requested', 'running', 'done', 'failed')),
  -- The checked proposals and questions (never the model's raw output).
  result        jsonb null,
  -- A code the page can explain: no_ai, allowance_used, key_rejected, provider_down, unreadable.
  error_code    text null,
  -- What the person did with the proposals, for "what it did for you".
  confirmed     integer not null default 0,
  discarded     integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index ai_requests_pending_idx on ai_requests (status) where status in ('requested', 'running');
create index ai_requests_household_idx on ai_requests (household_id, created_at desc);

-- Every call to a model: counts only, never the text (the settings page's
-- real usage). `key_source`: the household's own key, or our allowance.
create table ai_calls (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households (id) on delete cascade,
  request_id      uuid null references ai_requests (id) on delete set null,
  provider        text not null,
  model           text not null,
  key_source      text not null check (key_source in ('own', 'allowance')),
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  ok              boolean not null,
  created_at      timestamptz not null default now()
);

create index ai_calls_household_idx on ai_calls (household_id, created_at desc);

-- A household's own OpenAI key, sealed like a vendor session (§7.6, §14.3):
-- the api seals it and can never open it; only the worker can. The page only
-- ever sees the last four characters.
create table household_ai_keys (
  household_id  uuid primary key references households (id) on delete cascade,
  provider      text not null check (provider in ('openai')),
  key_sealed    text not null,
  key_last4     text not null,
  -- null until the worker's check call succeeds; a key that fails is removed.
  checked_at    timestamptz null,
  created_by    text null references users (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Measures the household uses in its own words ("a glass", "a cup"): asked
-- once, never guessed (§8, §9.12). amount is in the canonical unit.
create table household_measures (
  household_id  uuid not null references households (id) on delete cascade,
  measure       text not null check (length(measure) between 1 and 30 and measure = lower(measure)),
  unit          text not null check (unit in ('ml', 'g', 'piece')),
  amount        numeric not null check (amount > 0),
  created_at    timestamptz not null default now(),
  primary key (household_id, measure, unit)
);
