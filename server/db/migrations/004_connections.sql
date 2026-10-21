-- Connecting grocery apps (design §7.10, §10.2).
--
-- Secrets are stored only SEALED (design §14.3): the api can seal but never
-- open; only the worker holds the private key. Sealed values are bound to
-- their row + field, so they can't be moved between rows.

-- One connect attempt: phone → OTP → session. The sealed phone and OTP are
-- cleared once the attempt ends (connected, failed or expired), so they live
-- only as long as the attempt does.
create table connect_requests (
  id            uuid primary key,
  household_id  uuid not null references households (id) on delete cascade,
  user_id       text not null references users (id) on delete cascade,
  vendor        text not null,
  phone_sealed  text null,
  phone_last4   text not null,
  otp_sealed    text null,
  status        text not null check (status in
                  ('requested', 'sending_otp', 'otp_sent', 'verifying', 'connected', 'failed', 'expired')),
  -- A code the UI can explain (e.g. otp_invalid); never vendor text or a token.
  error_code    text null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- At most one in-flight attempt per user and vendor.
create unique index connect_requests_one_in_flight
  on connect_requests (user_id, vendor)
  where status in ('requested', 'sending_otp', 'otp_sent', 'verifying');

create index connect_requests_pending_idx on connect_requests (status) where status in ('requested', 'verifying');

-- A live connection: the sealed vendor session the worker syncs with.
create table vendor_connections (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households (id) on delete cascade,
  user_id         text not null references users (id) on delete cascade,
  vendor          text not null,
  phone_last4     text not null,
  session_sealed  text not null,
  status          text not null check (status in ('active', 'needs_reconnect', 'error')),
  last_sync_at    timestamptz null,
  last_error      text null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, vendor)
);
