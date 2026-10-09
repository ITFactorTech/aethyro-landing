-- Extends the credit_ledger reason check to allow 'referral_bonus'.
-- Used by the redeem-referral edge function when both parties earn 100 credits.

ALTER TABLE public.credit_ledger
  DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;

ALTER TABLE public.credit_ledger
  ADD CONSTRAINT credit_ledger_reason_check
    CHECK (reason = ANY (ARRAY[
      'purchase'::text, 'chat_usage'::text, 'signup_bonus'::text,
      'admin_adjustment'::text, 'referral_bonus'::text
    ]));
