-- "What do you want to make?" (design §19 "AI mode", §7.8): the household
-- says what it wants to cook, the model lists what the dish needs, and code
-- compares that with what the household already has. A new purpose on the
-- same AI requests: the same allowance, the same guardrails, the same
-- "nothing counts until you confirm it".
alter table ai_requests drop constraint ai_requests_purpose_check;
alter table ai_requests add constraint ai_requests_purpose_check
  check (purpose in ('parse_facts', 'check_key', 'plan_meal'));
