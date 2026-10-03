-- Fix: get_credit_balance(uuid) let any authenticated caller read ANY other
-- user's credit balance (no ownership check). Add the same is_admin()-or-self
-- guard the other privileged RPCs already use.
--
-- Pulled into the repo 2026-10-03 (site-guardian sweep) -- this migration was
-- applied live on 2026-10-02 but never committed, leaving it undocumented.
-- See the 2026-10-03 recent-work-log entry: the fix below is correct for the
-- disclosure bug it targets, but introduced a regression (chat/api-chat/
-- run-agent-task/run-routines all call this via a service-role client with
-- no per-user JWT, so auth.uid() is NULL and every one of those calls started
-- raising Forbidden) -- fixed in the very next migration.
CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN (
    SELECT COALESCE(SUM(cl.delta), 0)::integer
    FROM public.credit_ledger cl
    WHERE
      (
        (SELECT team_id FROM public.profiles WHERE id = p_user_id) IS NOT NULL
        AND cl.team_id = (SELECT team_id FROM public.profiles WHERE id = p_user_id)
      )
      OR (
        (SELECT team_id FROM public.profiles WHERE id = p_user_id) IS NULL
        AND cl.user_id = p_user_id
        AND cl.team_id IS NULL
      )
  );
END;
$$;

-- Defense in depth: app_secrets and admin_users already deny every row to
-- anon/authenticated (RLS enabled, zero policies = deny-all), so this changes
-- no legitimate behavior. It just stops the two tables from being
-- enumerable via the PostgREST/GraphQL schema to anyone who is signed in.
REVOKE ALL ON public.app_secrets FROM anon, authenticated;
REVOKE ALL ON public.admin_users FROM anon, authenticated;
