-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Clean up trial_usage rows older than 7 days (called manually or via cron)
CREATE OR REPLACE FUNCTION public.cleanup_old_trial_usage()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.trial_usage
  WHERE day < CURRENT_DATE - INTERVAL '7 days';
$$;

-- Also fix: ensure the 3rd profile user gets their signup bonus if missing
INSERT INTO public.credit_ledger (user_id, delta, reason, created_at)
SELECT u.id, 200, 'signup_bonus', u.created_at
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.credit_ledger cl
  WHERE cl.user_id = u.id AND cl.reason = 'signup_bonus'
)
AND EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.id = u.id
);
