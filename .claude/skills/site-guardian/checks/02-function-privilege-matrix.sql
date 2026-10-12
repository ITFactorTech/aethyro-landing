-- Check: a SECURITY DEFINER function's EXECUTE grant doesn't match its
-- intended caller(s) for every role individually.
--
-- First found by: classify_router_tier callable by any signed-in user
-- when it was meant to be service-role-only, 2026-09-29. Recurred on
-- cleanup_old_rate_limit_counters (2026-10-03) and get_monthly_spend
-- (2026-10-10) — same root cause each time: REVOKE ALL ... FROM PUBLIC
-- does NOT remove a role's own separate, earlier EXPLICIT grant, and
-- REVOKE ... FROM anon, authenticated is a no-op against a grant held by
-- PUBLIC (both are implicit members of it). Reading the REVOKE/GRANT
-- statements in a migration file is not sufficient — always read back the
-- live privilege state.
--
-- How to use: substitute <FUNCTION> with the function name and <ARGTYPES>
-- with its argument type list exactly as it appears in pg_proc (e.g.
-- 'uuid' or 'int' or '' for no-arg) — needed because this project has
-- real overloaded functions (get_credit_balance() vs get_credit_balance
-- (uuid)) with deliberately different privilege sets per overload.

select
  r.rolname as role,
  has_function_privilege(r.rolname, '<FUNCTION>(<ARGTYPES>)'::regprocedure, 'EXECUTE') as can_execute
from (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
order by r.rolname;

-- Clean result for a function meant to be service-role-only (its only
-- legitimate caller is an edge function's own supaAdmin client): anon
-- false, authenticated false, service_role true.
--
-- Clean result for a function meant to be callable by any signed-in user
-- doing its own internal auth.uid()/is_admin() check: anon false,
-- authenticated true, service_role true.
--
-- Mismatch: anon or authenticated showing true for a function that should
-- be service-role-only. Fix: REVOKE ALL ... FROM PUBLIC, anon,
-- authenticated explicitly (never rely on REVOKE FROM PUBLIC alone), then
-- re-run this query to confirm — not just re-reading the migration text.
