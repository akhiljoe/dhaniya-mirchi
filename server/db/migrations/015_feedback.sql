-- Feedback from the footer's "Send feedback" (design §12.8). Read by the
-- operator with `worker feedback`; no email address is exposed on the site.
create table feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     text null references users (id) on delete set null,
  message     text not null check (length(message) between 1 and 2000),
  -- Which page it was sent from (a view name like 'home'), nothing more.
  page        text null check (page is null or length(page) <= 40),
  created_at  timestamptz not null default now()
);

create index feedback_created_idx on feedback (created_at desc);
