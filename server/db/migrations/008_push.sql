-- Web Push (design §13.1). One row per browser the user turned
-- notifications on in. The endpoint is a capability URL (whoever holds it can
-- push to that browser), so it is never logged or sent back to a page.
create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null references users (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index push_subscriptions_user_idx on push_subscriptions (user_id);

-- "Your history is in" is sent once per milestone (design §7.10): the worker
-- claims a milestone by setting its column, so a notice is never sent twice.
alter table import_jobs
  add column ready_notified_at    timestamptz null,
  add column complete_notified_at timestamptz null;
