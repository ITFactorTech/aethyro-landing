-- Fixes a live billing bug: run-routines/index.ts and run-agent-task/index.ts
-- have always inserted credit_ledger rows with reason 'routine' / 'agent_task',
-- but credit_ledger_reason_check only ever allowed
-- purchase/chat_usage/signup_bonus/admin_adjustment/referral_bonus. Every
-- such insert has been silently failing (23514 check violation) since
-- neither function checks the insert's returned error. Confirmed
-- live: one real completed agent_tasks row shows credits_used: 12, but zero
-- matching credit_ledger row exists anywhere -- it ran a real Claude call and
-- charged nothing. No user_routines row has executed yet (last_run_at is
-- null for all of them), so that half of the bug hasn't hit a real balance
-- yet, but would identically the first time a routine actually runs.
ALTER TABLE public.credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_reason_check
  CHECK (reason = ANY (ARRAY[
    'purchase'::text, 'chat_usage'::text, 'signup_bonus'::text,
    'admin_adjustment'::text, 'referral_bonus'::text,
    'routine'::text, 'agent_task'::text
  ]));
