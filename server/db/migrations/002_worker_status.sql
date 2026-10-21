-- The worker's heartbeat (design §7.4, §11). One row: the api reads it to
-- report whether the worker is alive, so a dead worker is visible rather than
-- silently leaving households un-synced.
create table worker_status (
  id                 smallint primary key default 1 check (id = 1),
  last_heartbeat_at  timestamptz not null,
  chrome_version     text null
);
