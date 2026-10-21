-- The day the household's spending month starts (design §10.5).
--
-- A calendar month is not the month people budget in. The household that
-- asked for this pays by credit card billed on the 16th, so the question they
-- actually have is "how much will I have spent between the 16th of September
-- and the 15th of October" - and a forecast that answers about calendar
-- September answers a question nobody asked.
--
-- 1 is the calendar month, which stays the default. 29, 30 and 31 are allowed
-- because real cards use them; a cycle starting on the 31st begins on the
-- last day of any month too short for it, which is what the card does too.
alter table households add column billing_day integer not null default 1
  check (billing_day between 1 and 31);
