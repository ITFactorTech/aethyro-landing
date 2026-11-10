-- Closes the rest of the default-privileges write floor found by the 2026-11-09
-- backend-reviewer sweep (credit_ledger was fixed 2026-11-08, #239). Until now anon held
-- INSERT/UPDATE/DELETE/TRUNCATE on 13 more public tables and authenticated held write
-- (and TRUNCATE/REFERENCES/TRIGGER) privileges on tables with no client write path, with
-- only RLS standing between a client and a write. None of this removes a legitimate path:
--   * a repo grep of every *.html / *.js finds only SELECTs on referral_codes, referral_events,
--     agent_tasks, agent_task_steps (document_chunks, scheduled_emails, trial_usage and
--     user_credit_balances are not touched by client code at all);
--   * every writer to those tables is a service-role edge function or a SECURITY DEFINER
--     function owned by postgres, neither of which needs these grants;
--   * conversations, messages, user_routines, user_documents and memory_embeddings keep the
--     INSERT/UPDATE/DELETE that chat.html really uses for authenticated; only anon's writes
--     and authenticated's TRUNCATE/REFERENCES/TRIGGER (never reachable through PostgREST,
--     never needed) are removed.
-- Column-level SELECT grants (e.g. anon on user_routines, authenticated on profiles) are not
-- touched. newsletter_signups (anon INSERT) and api_keys / routine_webhooks (owner DELETE /
-- INSERT) are intentional and left alone.

-- anon: no write-class privileges on any of these.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.agent_task_steps, public.agent_tasks, public.conversations, public.document_chunks,
  public.memory_embeddings, public.messages, public.referral_codes, public.referral_events,
  public.user_credit_balances, public.user_documents, public.user_routines
FROM anon;

-- Service-role-only tables (policies are `false`; nothing client-side touches them).
REVOKE ALL ON public.scheduled_emails, public.trial_usage FROM anon, authenticated;

-- authenticated: TRUNCATE/REFERENCES/TRIGGER are never needed anywhere.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON
  public.agent_task_steps, public.agent_tasks, public.conversations, public.document_chunks,
  public.memory_embeddings, public.messages, public.referral_codes, public.referral_events,
  public.user_credit_balances, public.user_documents, public.user_routines
FROM authenticated;

-- authenticated: no client write path on these (read-only in the app; written only by
-- service-role edge functions or SECURITY DEFINER triggers).
REVOKE INSERT, UPDATE, DELETE ON
  public.referral_codes, public.referral_events, public.agent_tasks, public.agent_task_steps,
  public.document_chunks, public.user_credit_balances
FROM authenticated;

-- A trigger function (references NEW) that was directly callable via /rest/v1/rpc.
-- EXECUTE is only checked when the trigger is created, so firing it is unaffected.
REVOKE EXECUTE ON FUNCTION public.generate_referral_code() FROM PUBLIC, anon, authenticated;
