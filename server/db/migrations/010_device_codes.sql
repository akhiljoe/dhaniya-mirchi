-- Signing in on another device (a phone on the home network) with a short
-- one-time code from a signed-in browser. Google sign-in can't run on a plain
-- LAN address: Cognito allows http callbacks only for localhost.
-- Only the SHA-256 of the code is stored; a code is single-use, short-lived,
-- and a user holds at most one.
create table device_codes (
  code_hash   bytea primary key,
  user_id     text not null unique references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
