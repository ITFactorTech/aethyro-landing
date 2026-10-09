-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- 1. Efficient credit balance function (used by chat edge function)
CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(delta), 0)::integer
  FROM public.credit_ledger
  WHERE user_id = p_user_id;
$$;

-- 2. Index to make the SUM fast as ledger grows
CREATE INDEX IF NOT EXISTS credit_ledger_user_id_idx
  ON public.credit_ledger (user_id);

-- 3. Convenience view: current balance per user (joins profile for email)
CREATE OR REPLACE VIEW public.user_credit_balances AS
SELECT
  p.id AS user_id,
  p.email,
  COALESCE(SUM(cl.delta), 0)::integer AS balance,
  COUNT(cl.id) AS ledger_entries,
  MAX(cl.created_at) AS last_transaction_at
FROM public.profiles p
LEFT JOIN public.credit_ledger cl ON cl.user_id = p.id
GROUP BY p.id, p.email;

-- 4. Add created_at to trial_usage so we can audit and clean up old rows
ALTER TABLE public.trial_usage
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- 5. Index on trial_usage(day) for fast daily lookups
CREATE INDEX IF NOT EXISTS trial_usage_day_idx
  ON public.trial_usage (day);
