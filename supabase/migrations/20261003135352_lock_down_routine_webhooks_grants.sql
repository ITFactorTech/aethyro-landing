-- routine_webhooks had the full default-privilege auto-grant (SELECT/
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) to both anon and
-- authenticated -- the same recurring over-grant pattern this project has
-- hit on api_keys, user_routines, and get_credit_balance before. Not
-- currently exploitable (routine_webhooks_own's RLS qual joins to
-- user_routines.user_id = auth.uid(), which is NULL for anon and so never
-- matches), but anon had zero legitimate reason to hold any privilege here
-- at all, and authenticated only needs SELECT/INSERT/DELETE -- per the
-- existing design (CLAUDE.md: "owner can create/view/delete their own
-- routine's webhook row directly via supabase-js... no UPDATE grant needed
-- on the table at all, since regenerate is delete + re-insert").
REVOKE ALL ON public.routine_webhooks FROM anon;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.routine_webhooks FROM authenticated;
