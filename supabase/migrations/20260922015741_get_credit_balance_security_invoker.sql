-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Switch to SECURITY INVOKER — RLS on credit_ledger now applies to the caller.
-- anon callers: credit_ledger RLS denies all rows (no auth.uid())
-- authenticated callers: RLS restricts to their own rows only
-- service_role (edge functions): bypasses RLS, sees all rows — still works correctly
DROP FUNCTION IF EXISTS public.get_credit_balance(uuid);

CREATE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(delta), 0)::integer
  FROM public.credit_ledger
  WHERE user_id = p_user_id;
$$;
