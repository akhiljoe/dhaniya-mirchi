-- Users and sign-in sessions (design §10.1, §14.3).

-- A user is a Cognito subject. `id` IS the OIDC `sub`: opaque, stable, issued
-- per user pool. Only a provider-verified email is kept (for invites and the
-- email notification fallback, §13.1) — no name, no picture.
create table users (
  id            text primary key,
  email         text null,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- A browser's session. Only the SHA-256 of the token is stored — the token
-- itself exists only in the browser's cookie, so a database read yields
-- nothing that can be presented. The hash is the primary key: resolving a
-- session is one index probe, and there is no lookup "by user" to abuse.
-- `expires_at` is absolute and never extended on use.
create table sessions (
  token_hash    bytea primary key,
  user_id       text not null references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz null,
  last_used_at  timestamptz null
);

create index sessions_user_id_idx on sessions (user_id);
