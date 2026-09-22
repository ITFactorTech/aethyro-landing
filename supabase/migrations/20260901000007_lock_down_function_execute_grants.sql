-- Revoke EXECUTE from PUBLIC and per-role grants on internal functions
-- that should only be called by service_role (edge functions).

REVOKE EXECUTE ON FUNCTION public.grant_signup_bonus()          FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_trial_usage()     FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_credit_balance(uuid)      FROM anon, authenticated, PUBLIC;
