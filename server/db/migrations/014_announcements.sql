-- Announcements (design §13.3): the operator tells every user something — a
-- new feature, planned downtime. Never automatic: a row exists only because
-- the operator ran `worker announce`. Every user sees it under the bell;
-- with `push` the worker also sends it once to each user's browsers.
create table announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(title) between 1 and 80),
  body        text not null check (length(body) between 1 and 500),
  push        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Opened under the bell (per user; unread until then).
create table announcement_reads (
  announcement_id  uuid not null references announcements (id) on delete cascade,
  user_id          text not null references users (id) on delete cascade,
  read_at          timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- Pushed to a user's browsers — claimed before sending, so never twice.
create table announcement_deliveries (
  announcement_id  uuid not null references announcements (id) on delete cascade,
  user_id          text not null references users (id) on delete cascade,
  pushed_at        timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
