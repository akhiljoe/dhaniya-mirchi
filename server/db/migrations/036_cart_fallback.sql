-- Whether, when the household's usual app does not have something, the cart
-- sheet offers it from the other app.
--
-- The offer is made from the household's own orders - a thing bought on the
-- other app before - and for most households it is the answer to "the store
-- did not have my bananas". Some would rather not be shown the other app at
-- all, and for them it is a switch, beside the choice of usual app, on the
-- page where the apps already live.
alter table households
  add column cart_fallback boolean not null default true;

comment on column households.cart_fallback is
  'Offer things the usual app lacks from the other connected app. Default on.';
