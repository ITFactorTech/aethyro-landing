-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Drop and recreate without the PUBLIC grant — CREATE OR REPLACE preserves grants
-- from the first creation, so we must drop and rebuild to clear them cleanly.
DROP FUNCTION IF EXISTS public.get_credit_balance(uuid);

CREATE FUNCTION public.get_credit_balance(p_user_id uuid)
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

-- No GRANT to anon/authenticated/PUBLIC — only service_role (edge functions) uses it
REVOKE ALL ON FUNCTION public.get_credit_balance(uuid) FROM PUBLIC, anon, authenticated;
