-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- PostgreSQL grants EXECUTE to PUBLIC by default on new functions.
-- anon and authenticated inherit from PUBLIC, so revoking from the
-- roles alone is not enough — must revoke from PUBLIC too.

-- ── Trigger-only functions: no direct API calls needed ────────────────
REVOKE EXECUTE ON FUNCTION public.grant_signup_bonus() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.queue_onboarding_emails() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_conversation_updated_at() FROM PUBLIC;

-- ── Admin/internal functions ─────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.cleanup_old_trial_usage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance(uuid) FROM PUBLIC;
-- Edge functions use service_role key which bypasses grants entirely,
-- so no GRANT back is needed for these.

-- ── increment_trial_usage: called by trial-chat edge fn (service_role) ─
REVOKE EXECUTE ON FUNCTION public.increment_trial_usage(text, date) FROM PUBLIC;

-- ── Forum functions: anon should not rate/post; authenticated can ─────
REVOKE EXECUTE ON FUNCTION public.forum_after_post() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.forum_rate_post() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.forum_rate_thread() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forum_after_post() TO authenticated;
GRANT EXECUTE ON FUNCTION public.forum_rate_post() TO authenticated;
GRANT EXECUTE ON FUNCTION public.forum_rate_thread() TO authenticated;

-- ── newsletter_index / pack_index: public catalog — keep anon access ──
-- (these serve the dashboard product/newsletter listings to all visitors)
-- No change needed — leaving PUBLIC grant in place is correct here.

-- ── Revoke authenticated SELECT on internal tables not needed by client ─
-- scheduled_emails: internal email queue — users shouldn't query it
-- trial_usage: rate-limit counters — users shouldn't query it
-- Both have deny-all RLS policies already; this removes the GraphQL exposure too.
REVOKE SELECT ON public.scheduled_emails FROM authenticated;
REVOKE SELECT ON public.trial_usage FROM authenticated;
