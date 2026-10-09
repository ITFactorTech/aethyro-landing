-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- ============================================================
-- Security hardening migration
-- Fixes all issues flagged by the Supabase security advisor
-- ============================================================

-- ── 1. referral_events: add RLS policies (table had RLS enabled, no policies) ──
-- Without any policy, RLS blocks ALL access even for row owners.
CREATE POLICY "referral_events_select_own"
  ON public.referral_events
  FOR SELECT
  TO authenticated
  USING (referrer_user_id = auth.uid() OR referee_user_id = auth.uid());

-- Service-role key bypasses RLS, so inserts from edge functions are unaffected.

-- ── 2. generate_referral_code(): revoke anon EXECUTE ────────────────────────
-- SECURITY DEFINER functions run as the definer (postgres), not the caller.
-- No unauthenticated user should be able to generate codes.
REVOKE EXECUTE ON FUNCTION public.generate_referral_code() FROM anon;

-- ── 3. Fix mutable search_path on vector search functions ───────────────────
-- Pins the search path so these functions cannot be hijacked by a schema
-- injection if the caller's search_path is manipulated.
ALTER FUNCTION public.match_memory_embeddings(p_user_id uuid, p_embedding vector, p_limit integer)
  SET search_path = public, extensions;

ALTER FUNCTION public.match_document_chunks(p_user_id uuid, p_embedding vector, p_limit integer)
  SET search_path = public, extensions;

-- ── 4. Revoke anon SELECT from all private tables ───────────────────────────
-- RLS already protects row-level data, but revoking SELECT from anon hides
-- the table schema entirely from unauthenticated PostgREST/GraphQL requests.
-- newsletter_issues and pack_content are intentionally public-readable; skip them.

REVOKE SELECT ON public.agent_tasks        FROM anon;
REVOKE SELECT ON public.agent_task_steps   FROM anon;
REVOKE SELECT ON public.document_chunks    FROM anon;
REVOKE SELECT ON public.memory_embeddings  FROM anon;
REVOKE SELECT ON public.user_documents     FROM anon;
REVOKE SELECT ON public.user_integrations  FROM anon;
REVOKE SELECT ON public.user_routines      FROM anon;
REVOKE SELECT ON public.referral_codes     FROM anon;
REVOKE SELECT ON public.referral_events    FROM anon;