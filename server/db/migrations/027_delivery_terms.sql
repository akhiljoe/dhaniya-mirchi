-- What this store charges for delivery, and the figure it says delivery is
-- free above. Kept on the connection so the app can say "₹12 more and
-- delivery is free" while a list is being built, rather than only after a
-- cart has been filled - the cart's own answer is where the store states it,
-- and that answer was being read and thrown away.
--
-- Both are the store's own words, never ours. Null means it has not told us,
-- and the app then says nothing about delivery (design §9.3: no invented
-- numbers). `delivery_terms_at` is when it last did, so a stale figure can
-- be told from a fresh one.
alter table vendor_connections
  add column if not exists free_delivery_above numeric,
  add column if not exists delivery_fee        numeric,
  add column if not exists delivery_terms_at   timestamptz;
