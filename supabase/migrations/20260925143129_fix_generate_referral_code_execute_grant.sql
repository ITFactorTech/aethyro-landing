-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- Revoke the PUBLIC EXECUTE grant (anon inherits from PUBLIC)
REVOKE EXECUTE ON FUNCTION public.generate_referral_code() FROM PUBLIC;

-- Re-grant to only the roles that should be able to call it
GRANT EXECUTE ON FUNCTION public.generate_referral_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_referral_code() TO service_role;