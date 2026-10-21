-- A person's name, for the pages that name a person. Every screen that said
-- who did something said it with the email's local part - "owner",
-- "member's" - which nobody calls anybody. Filled from Google's given_name
-- at sign-in when empty, and editable by the person on the Household page;
-- an edit is never overwritten by a later sign-in.
alter table users add column if not exists display_name text;
