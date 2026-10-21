-- The user can cancel a connect attempt — typed the wrong number, say
-- (design §7.10). A cancelled attempt is final, clears its sealed phone and
-- OTP, and no longer holds the one-in-flight slot, so a new one can start.
alter table connect_requests drop constraint connect_requests_status_check;
alter table connect_requests add constraint connect_requests_status_check check (status in
  ('requested', 'sending_otp', 'otp_sent', 'verifying', 'connected', 'failed', 'expired', 'cancelled'));
