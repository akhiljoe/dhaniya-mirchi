-- Whether this connection's session can reach the vendor's own checkout.
--
-- A session can be perfectly alive for reading and still be unable to pay.
-- That is not a hypothetical: every Blinkit connection made before
-- 2026-09-23 imports orders faultlessly and is refused at the vendor's own
-- cart page with "Login to Proceed", because connecting wrote the token into
-- the page but not the `user` block the checkout reads (design Appendix A).
--
-- `status` cannot carry this. Marking such a connection `needs_reconnect`
-- would be a lie in the other direction: nothing is wrong with it for the
-- ninety-nine percent of the app that reads. So it gets its own column.
--
--   null   nobody has looked yet. Says nothing, and must not be read as a no.
--   true   the session reached the checkout the last time it was opened.
--   false  it was refused, and paying needs a reconnect.
alter table vendor_connections
  add column checkout_ready boolean null;

comment on column vendor_connections.checkout_ready is
  'null = not checked, true = the vendor''s checkout accepted this session, false = it wants a fresh login. Read at sync time; only paying depends on it.';
