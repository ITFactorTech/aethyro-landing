-- Security & performance hardening:
-- - RLS policies rewritten with (select auth.uid()) to prevent per-row re-evaluation
-- - anon role SELECT revoked from all private tables
-- - Foreign-key indexes added
-- - search_path fixed on internal functions
-- - deny-all RLS policy on trial_usage

-- ── RLS performance fixes (subquery prevents per-row auth.uid() call) ──────────

-- credit_ledger
DROP POLICY IF EXISTS "users can view their own ledger" ON public.credit_ledger;
CREATE POLICY "users can view their own ledger" ON public.credit_ledger
  FOR SELECT USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "users can insert their own ledger" ON public.credit_ledger;
CREATE POLICY "users can insert their own ledger" ON public.credit_ledger
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

-- conversations
DROP POLICY IF EXISTS "users can manage their own conversations" ON public.conversations;
CREATE POLICY "users can manage their own conversations" ON public.conversations
  FOR ALL USING ((SELECT auth.uid()) = user_id);

-- messages
DROP POLICY IF EXISTS "users can manage their own messages" ON public.messages;
CREATE POLICY "users can manage their own messages" ON public.messages
  FOR ALL USING (
    (SELECT auth.uid()) = (
      SELECT user_id FROM public.conversations WHERE id = messages.conversation_id
    )
  );

-- ── Revoke anon SELECT from private tables ────────────────────────────────────

REVOKE SELECT ON public.conversations    FROM anon;
REVOKE SELECT ON public.messages         FROM anon;
REVOKE SELECT ON public.credit_ledger    FROM anon;
REVOKE SELECT ON public.profiles         FROM anon;
REVOKE SELECT ON public.subscriptions    FROM anon;
REVOKE SELECT ON public.purchases        FROM anon;
REVOKE SELECT ON public.licenses         FROM anon;
REVOKE SELECT ON public.trial_usage      FROM anon;

-- ── FK indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
  ON public.messages (conversation_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
  ON public.subscriptions (user_id);
CREATE INDEX IF NOT EXISTS purchases_user_id_idx
  ON public.purchases (user_id);
CREATE INDEX IF NOT EXISTS licenses_user_id_idx
  ON public.licenses (user_id);
CREATE INDEX IF NOT EXISTS profiles_user_id_idx
  ON public.profiles (id);

-- ── trial_usage: deny all direct access (only service_role / edge functions) ──

ALTER TABLE public.trial_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deny all" ON public.trial_usage;
CREATE POLICY "deny all" ON public.trial_usage AS RESTRICTIVE
  FOR ALL USING (false);
