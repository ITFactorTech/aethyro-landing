-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Revoke all explicit per-role grants (PUBLIC revoke alone wasn't enough —
-- Supabase had also granted directly to anon and authenticated)

-- Internal / trigger-only functions
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.queue_onboarding_emails() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_conversation_updated_at() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.grant_signup_bonus() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_trial_usage() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_trial_usage(text, date) FROM anon, authenticated, PUBLIC;

-- get_credit_balance: only service_role calls it (via edge function), not clients
REVOKE EXECUTE ON FUNCTION public.get_credit_balance(uuid) FROM anon, authenticated, PUBLIC;

-- Forum functions: anon should not rate/post — authenticated is fine
REVOKE EXECUTE ON FUNCTION public.forum_after_post() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.forum_rate_post() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.forum_rate_thread() FROM anon, PUBLIC;
-- Keep authenticated grant for forum_* (users must be logged in to interact)
