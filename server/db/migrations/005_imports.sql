-- Importing order history (design §7.10, §10.2).

-- One import run for one connection: the first full history, or a later
-- incremental sync. Progress lives here so the page can poll it and the user
-- can leave (design §7.10). Re-running a job is idempotent, so a job left
-- mid-flight by a worker restart is simply picked up again.
create table import_jobs (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households (id) on delete cascade,
  connection_id  uuid not null references vendor_connections (id) on delete cascade,
  vendor         text not null,
  status         text not null check (status in ('queued', 'listing', 'packs', 'complete', 'needs_reconnect', 'failed')),
  orders_done    integer not null default 0,
  skus_total     integer null,          -- null until the order list is fully fetched
  skus_done      integer not null default 0,
  step_ms        integer[] not null default '{}',  -- recent pack-lookup durations → ETA
  ready_at       timestamptz null,      -- the most-bought items resolved: usable
  completed_at   timestamptz null,
  error_code     text null,             -- never vendor text or a token
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- At most one live import per connection.
create unique index import_jobs_one_live on import_jobs (connection_id)
  where status in ('queued', 'listing', 'packs');

-- Every ingested order, deduped. `items` holds line items only — name, SKU,
-- store, count, price — never the delivery address, phone or name (design
-- §7.6). The address survives only as its label and a one-way reference for
-- the tracked-address filter (§7.9).
create table raw_orders (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households (id) on delete cascade,
  connection_id    uuid not null references vendor_connections (id) on delete cascade,
  vendor           text not null,
  vendor_order_id  text not null,
  placed_at        timestamptz not null,
  status           text not null,
  total            numeric null,
  address_label    text null,
  address_ref      text null,
  items            jsonb not null,
  created_at       timestamptz not null default now(),
  unique (vendor, vendor_order_id)
);

create index raw_orders_connection_idx on raw_orders (connection_id, placed_at desc);

-- Catalog pack sizes by SKU (design Appendix C). Product data, not personal:
-- shared across households, so a second household's import skips every SKU
-- the first already resolved. label null = searched, not found (ask once).
create table sku_packs (
  vendor       text not null,
  store_id     bigint not null,
  sku          text not null,
  label        text null,
  resolved_at  timestamptz not null default now(),
  primary key (vendor, store_id, sku)
);
