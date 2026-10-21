-- What the household actually agrees to pay (design §19 stage 2).
--
-- `max_total` is read off the cart, and the cart's bill is not what the
-- checkout charges: on 2026-09-22 a cart billed at ₹130 (48 items, 30
-- delivery, 9 surge, 20 small cart - which is itself only 107) reached the
-- payment screen as ₹147. The vendor adds fees neither we nor its own cart
-- call spell out, so a number taken from the cart can never be trusted as the
-- number that will be charged.
--
-- Rather than guess at the difference or allow a tolerance - both of which
-- would mean paying an amount nobody ever saw - the worker stops on the
-- payment screen, shows the vendor's own total, and waits. `agreed_total` is
-- what the household then agreed to, and it must equal the total the screen
-- showed, exactly. The hard cap still binds above it.
alter table order_jobs add column agreed_total numeric null;

-- 'awaiting_ok': the worker is on the payment screen, the total there is more
-- than was agreed at the cart, and it is waiting to be told whether to pay it.
-- Nothing has been ordered in this state and giving up costs nothing.
alter table order_jobs drop constraint order_jobs_status_check;
alter table order_jobs add constraint order_jobs_status_check
  check (status in ('requested', 'running', 'awaiting_ok', 'awaiting_cvv', 'paying', 'awaiting_otp', 'done', 'failed'));

drop index order_jobs_pending_idx;
create index order_jobs_pending_idx on order_jobs (status)
  where status in ('requested', 'running', 'awaiting_ok', 'awaiting_cvv', 'paying', 'awaiting_otp');

drop index order_jobs_one_live_per_household;
create unique index order_jobs_one_live_per_household
  on order_jobs (household_id)
  where status in ('requested', 'running', 'awaiting_ok', 'awaiting_cvv', 'paying', 'awaiting_otp');
