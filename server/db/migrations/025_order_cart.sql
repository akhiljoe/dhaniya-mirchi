-- The cart an order is paying for (design §19 stage 2).
--
-- Three gaps, one cause: the order knew nothing about the cart the household
-- had actually looked at.
--
--   * It checked the payment screen's TOTAL and never its contents. The
--     vendor's own app pushes its cart up whenever it has one, so between
--     Send and Pay the lines can change under them - and a different cart
--     that happens to come to the same money would have been paid for
--     without a word.
--   * A household with two accounts on one vendor (this one has four
--     connections) had the cart filled through whichever connection was
--     oldest and the order placed through whichever was oldest, agreeing
--     only by luck. The order now uses the cart's own connection.
--   * `result` was declared in 022 and never written, which is a stub
--     column.
alter table order_jobs add column cart_job_id uuid null references cart_jobs (id) on delete set null;
-- How many lines the household was looking at when they tapped. The payment
-- screen says how many it is about to charge for; they have to agree.
alter table order_jobs add column cart_lines integer null;
