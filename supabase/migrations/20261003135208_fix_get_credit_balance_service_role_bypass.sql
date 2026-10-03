-- Fix: the 2026-10-02 hardening of get_credit_balance(uuid) (previous
-- migration) added an auth.uid() = p_user_id OR is_admin() guard to stop
-- arbitrary-balance disclosure -- correct for that bug, but it broke the
-- function's only other real caller: chat/api-chat/run-agent-task/
-- run-routines all call it via a service-role client (supaAdmin) with no
-- per-user JWT, so auth.uid() is NULL there and the guard raised Forbidden
-- on every single call.
--
-- Confirmed live and real, not theoretical: a throwaway test account with a
-- real -9801 credit balance still got a successful, billed chat reply,
-- because chat's `const { data: balance } = await supaAdmin.rpc(...)`
-- discards the RPC's error, so the Forbidden exception silently became
-- `balance: null`, and `typeof null === 'number'` is false -- the
-- `balance <= 0` no-credits gate never fired. The same broken call also
-- meant the live balance shown after every chat message (`cost.balance` in
-- chat.html) was always null instead of a real number, since 2026-10-02.
-- This one function is called the same way by api-chat, run-agent-task, and
-- run-routines too, so fixing it here fixes the credit gate for all four
-- surfaces at once -- no edge function code changes needed.
--
-- Fix: let service_role bypass the ownership check. GRANT already restricts
-- EXECUTE on this overload to service_role (confirmed via
-- has_function_privilege: authenticated=false, anon=false, service_role=
-- true), so this doesn't open anything new to a client -- it just lets the
-- function's only legitimate internal caller actually call it.
CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' AND auth.uid() IS DISTINCT FROM p_user_id AND NOT public.is_admin() THEN
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
$function$;
