-- Which app this household's carts go to unless they say otherwise.
--
-- Until now the app had one hardcoded vendor, and when a second one could
-- take a cart the screen grew a row of buttons to pick between them on every
-- send. That is a question asked far too often: a household shops at one of
-- them nearly always, and the other is the exception.
--
-- So it is a setting, chosen once where the apps already live, and the
-- basket simply says where it is about to send.
--
-- Null means "not chosen": the app falls back to whichever connected vendor
-- it can fill, rather than pretending a preference exists.
alter table households
  add column cart_vendor text null;

comment on column households.cart_vendor is
  'The app carts are sent to by default. Null = not chosen; the app picks one it can fill.';
