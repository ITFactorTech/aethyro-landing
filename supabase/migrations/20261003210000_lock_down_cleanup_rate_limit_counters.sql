-- site-guardian sweep (2026-10-03): cleanup_old_rate_limit_counters(), added
-- by the same-day 20261003160000_rate_limit_counters.sql migration, was left
-- with no REVOKE/GRANT statements -- unlike that migration's other new
-- function (increment_rate_limit(), which correctly locks EXECUTE to
-- service_role only), this one inherited the project's default EXECUTE
-- grant to anon/authenticated and was directly callable via
-- /rest/v1/rpc/cleanup_old_rate_limit_counters by anyone, signed in or not.
-- Same recurring bug class this project has hit repeatedly (classify_router_tier,
-- api_keys, get_credit_balance) -- a new SECURITY DEFINER function's default
-- grant is a floor, not a ceiling, unless explicitly revoked.
--
-- Its only legitimate caller is the cleanup-rate-limit-counters-hourly
-- pg_cron job, which runs as a superuser role and is unaffected by this
-- revoke (superuser bypasses GRANT checks entirely) -- same reasoning this
-- repo already applied to trigger_welcome_email()'s equivalent lockdown.
REVOKE ALL ON FUNCTION public.cleanup_old_rate_limit_counters() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_rate_limit_counters() TO service_role, postgres;
