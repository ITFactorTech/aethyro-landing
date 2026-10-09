-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- ============================================================
-- 1. REVOKE dangerous function access from anon/authenticated
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.cleanup_old_trial_usage() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.grant_signup_bonus() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance(uuid) FROM anon;
-- keep get_credit_balance callable by authenticated (chat edge fn uses service role, but keep tidy)

-- ============================================================
-- 2. REVOKE anon SELECT on sensitive tables (GraphQL exposure)
-- ============================================================
REVOKE SELECT ON public.credit_ledger FROM anon;
REVOKE SELECT ON public.conversations FROM anon;
REVOKE SELECT ON public.messages FROM anon;
REVOKE SELECT ON public.scheduled_emails FROM anon;
REVOKE SELECT ON public.trial_usage FROM anon;
REVOKE SELECT ON public.user_credit_balances FROM anon;

-- ============================================================
-- 3. Fix RLS policies: use (select auth.uid()) for performance
--    (avoids re-evaluation per row)
-- ============================================================

-- credit_ledger
DROP POLICY IF EXISTS "users can view their own ledger" ON public.credit_ledger;
CREATE POLICY "users can view their own ledger" ON public.credit_ledger
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

-- conversations
DROP POLICY IF EXISTS "users own their conversations" ON public.conversations;
CREATE POLICY "users own their conversations" ON public.conversations
  FOR ALL USING ((SELECT auth.uid()) = user_id);

-- messages (subquery also now uses select form)
DROP POLICY IF EXISTS "users own their messages" ON public.messages;
CREATE POLICY "users own their messages" ON public.messages
  FOR ALL USING (
    conversation_id IN (
      SELECT id FROM public.conversations
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- ============================================================
-- 4. Add missing FK indexes (performance)
-- ============================================================
CREATE INDEX IF NOT EXISTS forum_posts_thread_id_idx ON public.forum_posts (thread_id);
CREATE INDEX IF NOT EXISTS forum_posts_user_id_idx ON public.forum_posts (user_id);
CREATE INDEX IF NOT EXISTS forum_reports_user_id_idx ON public.forum_reports (user_id);
CREATE INDEX IF NOT EXISTS forum_threads_user_id_idx ON public.forum_threads (user_id);
CREATE INDEX IF NOT EXISTS scheduled_emails_user_id_idx ON public.scheduled_emails (user_id);

-- ============================================================
-- 5. Fix mutable search_path on existing functions
-- ============================================================
CREATE OR REPLACE FUNCTION public.queue_onboarding_emails()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  INSERT INTO public.scheduled_emails (user_id, email, first_name, email_num, send_at)
  SELECT
    NEW.id,
    NEW.email,
    split_part(NEW.raw_user_meta_data->>'full_name', ' ', 1),
    gs.n,
    now() + (gs.n * INTERVAL '1 day')
  FROM generate_series(1, 3) gs(n)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$func$;

CREATE OR REPLACE FUNCTION public.touch_conversation_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  UPDATE public.conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$func$;

-- ============================================================
-- 6. Add RLS policy for trial_usage (was enabled with no policy)
--    Only service_role writes it; anon can't read it directly.
--    This satisfies the lint without opening access.
-- ============================================================
DROP POLICY IF EXISTS "service role only" ON public.trial_usage;
CREATE POLICY "service role only" ON public.trial_usage
  FOR ALL USING (false);
-- service_role bypasses RLS so the edge function still works fine.
