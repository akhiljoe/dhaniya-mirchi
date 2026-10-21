-- Which address a household's cart is filled for (design §19 stage 1).
-- Instamart keeps a cart per store, and the store follows from the delivery
-- address: filling a cart for a different address puts the items in a cart
-- the household never sees (seen on a real account, 2026-09-20).
--
-- `addresses` is what the app had saved when the household connected it, so
-- the app can ask which one without another trip through the vendor; only
-- what picking a store needs is kept (id, the household's own label, the
-- address as the app shows it, coordinates) — no phone, no contact name.
alter table vendor_connections
  add column addresses    jsonb not null default '[]'::jsonb,
  add column cart_address jsonb null;
