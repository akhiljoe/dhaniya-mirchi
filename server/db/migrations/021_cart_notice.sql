-- A cart fill takes half a minute, and the household should not have to sit
-- and watch it: "you can't leave the app after pressing send" was the
-- complaint (2026-09-21). It can leave, as long as something tells it when the
-- cart is ready. This records that the telling happened, so a notice is sent
-- once and not again on the next sweep.
alter table cart_jobs add column notified_at timestamptz null;
