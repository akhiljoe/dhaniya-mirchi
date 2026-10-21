-- Stopping a cart that is being filled. There was no way to: once Send was
-- tapped the worker drove the vendor's page to the end, and a household who
-- changed their mind could only watch.
--
-- A running job cannot be killed outright - it is putting things in a real
-- cart through a real browser - so this is a request the worker reads
-- between items. What is already in the cart stays there and is reported,
-- because saying "cancelled" about a cart with six things in it would be the
-- same lie the order code refuses to tell.
alter table cart_jobs add column if not exists cancel_requested_at timestamptz;
