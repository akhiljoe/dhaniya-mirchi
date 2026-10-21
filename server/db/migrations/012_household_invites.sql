-- Adding someone to a household (design §10.1, §19 "Multi-member households").
--
-- An invite names a verified email, never a link: whoever signs in with that
-- Google account sees it and can accept. Nothing about the invite is secret,
-- so a forwarded message can't let anyone else in. Accepting (or declining)
-- deletes the row; an invite nobody answers expires.
create table household_invites (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households (id) on delete cascade,
  email         text not null check (email = lower(email)),
  invited_by    text not null references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  unique (household_id, email)
);

create index household_invites_email_idx on household_invites (email);
