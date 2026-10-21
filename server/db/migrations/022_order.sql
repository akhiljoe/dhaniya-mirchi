-- Paying for the cart from the app (design §19 Ordering, stages 2 and 3).
-- Stage 1 stopped at the vendor's cart and let the household pay in the
-- vendor's own app. This is the step past it: the worker drives the vendor's
-- payment screen, and for a card the household types the CVV and then the
-- bank's OTP on our page and the worker relays each one.
--
-- Three things about this table exist because of one fact: the vendor creates
-- the order BEFORE the money moves (`checkout/order` answers PLACED with
-- payment_status PENDING). So:
--
--   * `vendor_order_id` and `paid` are separate. An order that exists and was
--     not paid for is a real state the household has to be shown, never
--     assumed away.
--   * `pay_pressed_at` is written the moment the button that spends money is
--     tapped. After that moment a job may never be quietly retried: a retry
--     could place a second order.
--   * `max_total` is what the household agreed to when they tapped. The
--     worker re-reads the vendor's own total on the payment screen and stops
--     if it is higher. Nobody is ever charged more than the number they saw.
create table order_jobs (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households (id) on delete cascade,
  connection_id   uuid not null references vendor_connections (id) on delete cascade,
  -- Who tapped. An order is never placed without a person asking for it.
  user_id         text not null references users (id) on delete cascade,
  vendor          text not null,

  -- 'card': the household picks a saved card and types its CVV, then the
  -- bank's OTP. 'on_delivery': nothing is typed and nothing is relayed.
  method          text not null check (method in ('card', 'on_delivery')),
  -- Which saved card, by the name the vendor's own screen shows it under
  -- ("Alex Bank Card 1111"). Never a number, never a token.
  card_label      text null,

  -- The most the household agreed to pay, in rupees, and the total the
  -- vendor's payment screen actually showed when the worker got there.
  max_total       numeric not null check (max_total > 0),
  vendor_total    numeric null,

  --   requested    the household tapped; nothing has been touched yet
  --   running      the worker is on the payment screen
  --   awaiting_cvv the card is chosen; waiting for the household to type it
  --   paying       Pay was pressed; an order may now exist
  --   awaiting_otp the bank is asking; waiting for the household to type it
  --   done         the vendor says the payment went through
  --   failed       see error_code; `vendor_order_id` says whether an order
  --                was left behind
  status          text not null check (status in ('requested', 'running', 'awaiting_cvv', 'paying', 'awaiting_otp', 'done', 'failed')),

  -- What the household is waiting to be asked for, sealed by the api to the
  -- vault's public key the moment it arrives and opened only inside the
  -- worker. Written once, read once, and set back to null the moment it has
  -- been typed into the vendor's page. Never logged, never sent to a browser,
  -- never kept.
  secret_sealed   text null,
  secret_kind     text null check (secret_kind in ('cvv', 'otp')),
  secret_at       timestamptz null,

  vendor_order_id text null,
  paid            boolean not null default false,
  pay_pressed_at  timestamptz null,
  error_code      text null,
  -- The lines and totals as the vendor billed them. Never an address, never
  -- a card detail (design §7.6).
  result          jsonb null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index order_jobs_pending_idx on order_jobs (status) where status in ('requested', 'running', 'awaiting_cvv', 'paying', 'awaiting_otp');
create index order_jobs_household_idx on order_jobs (household_id, created_at desc);

-- One order at a time per household. Two at once would race on the same cart
-- and could pay twice for the same food.
create unique index order_jobs_one_live_per_household
  on order_jobs (household_id)
  where status in ('requested', 'running', 'awaiting_cvv', 'paying', 'awaiting_otp');

-- The saved cards the vendor's payment screen showed, by the names it shows
-- them under ("Alex Bank Card 1111"). Never a number and never a token: the
-- name is only how the worker finds the right row to tick, and how the
-- household is asked which one they mean. Written whenever a payment screen
-- is read, so the app can offer a choice instead of guessing.
alter table vendor_connections add column cards jsonb not null default '[]'::jsonb;
