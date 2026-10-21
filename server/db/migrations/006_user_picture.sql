-- The Google profile photo URL (design §14.3), only when the profile scope is
-- on. Stored server-side only: the api relays the image from our own origin
-- and never hands this URL to the browser. Only a pinned Google photo host is
-- ever stored or fetched.
alter table users add column picture_url text null;
