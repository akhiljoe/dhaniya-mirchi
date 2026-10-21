-- Add to cart (design §19 Ordering, stage 1 "cart handoff"): the household
-- ticks items, the worker puts them in the household's real vendor cart
-- through its own saved session, and the household pays in the vendor's app.
-- Nothing here touches payment.
create table cart_jobs (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households (id) on delete cascade,
  connection_id  uuid not null references vendor_connections (id) on delete cascade,
  user_id        text null references users (id) on delete set null,
  vendor         text not null,
  -- What was asked for: [{item, product, pack, qty}] — the canonical item,
  -- the vendor's own product name, its pack label and how many.
  wanted         jsonb not null,
  status         text not null check (status in ('requested', 'running', 'done', 'failed')),
  -- What happened, line by line, plus the cart's totals as the vendor bills
  -- them (never any address or payment detail).
  result         jsonb null,
  error_code     text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index cart_jobs_pending_idx on cart_jobs (status) where status in ('requested', 'running');
create index cart_jobs_household_idx on cart_jobs (household_id, created_at desc);

-- Everything the app put in a cart. A purchase the app prompted must never
-- feed the consumption rate (design §9.1, §9.2): when one of these products
-- turns up in the order history soon after, that purchase is prompted.
create table prompted_adds (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  cart_job_id   uuid null references cart_jobs (id) on delete set null,
  vendor        text not null,
  -- The canonical item ("milk") and the vendor's own product and pack.
  item          text not null,
  sku           text null,
  product       text not null,
  pack          text null,
  quantity      integer not null,
  created_at    timestamptz not null default now()
);

create index prompted_adds_household_idx on prompted_adds (household_id, created_at desc);
