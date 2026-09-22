-- Final fix for get_credit_balance: recreate as SECURITY INVOKER so RLS
-- on credit_ledger naturally blocks anon callers even if EXECUTE grant leaks.
-- SECURITY INVOKER means:
--   anon callers  → credit_ledger RLS denies all rows (no auth.uid())
--   authenticated → RLS restricts to their own rows only
--   service_role  → bypasses RLS, sees all rows (edge functions still work)

DROP FUNCTION IF EXISTS public.get_credit_balance(uuid);

CREATE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT COALESCE(SUM(delta), 0)::integer
  FROM public.credit_ledger
  WHERE user_id = p_user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_credit_balance(uuid) FROM anon, authenticated, PUBLIC;
