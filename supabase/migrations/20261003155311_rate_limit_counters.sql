-- Per-user / per-API-key rate limiting for authenticated chat and the
-- public API. Closes the P2 gap this project's own site audit and
-- developers.html both documented: "no hard per-minute cap beyond the
-- credit balance itself" on `chat` and `api-chat`.
--
-- Same fixed-window counter pattern trial_usage/increment_trial_usage
-- already use for the anonymous trial endpoint, generalized with a
-- key_type column so one table/RPC serves both chat (keyed by user_id)
-- and api-chat (keyed by api_keys.id) instead of duplicating it.
--
-- SECURITY DEFINER + service_role-only by design (not the auth.uid()-based
-- self-service check get_credit_balance uses): the only legitimate caller
-- is each edge function's own supaAdmin client, never a per-user JWT, so
-- there's no "OR auth.uid() = ..." branch to get wrong here -- see this
-- file's own 2026-10-03 get_credit_balance incident for exactly what
-- happens when that distinction is missed.
CREATE TABLE public.rate_limit_counters (
  key_type     text        NOT NULL,
  key_value    text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (key_type, key_value, window_start)
);

ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
-- No policies: deny-all, same pattern as admin_users/app_secrets. Only
-- increment_rate_limit() (SECURITY DEFINER, service_role-gated) and direct
-- SQL ever touch this table.
REVOKE ALL ON public.rate_limit_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_key_type text, p_key_value text, p_window_start timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  INSERT INTO public.rate_limit_counters (key_type, key_value, window_start, count)
  VALUES (p_key_type, p_key_value, p_window_start, 1)
  ON CONFLICT (key_type, key_value, window_start)
  DO UPDATE SET count = public.rate_limit_counters.count + 1
  RETURNING count INTO new_count;

  RETURN new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_rate_limit(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit(text, text, timestamptz) TO service_role;

-- Cleanup, same shape as cleanup_old_trial_usage(): fixed-window rows
-- accumulate one per key per minute, so prune anything over an hour old.
CREATE OR REPLACE FUNCTION public.cleanup_old_rate_limit_counters()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.rate_limit_counters
  WHERE window_start < now() - interval '1 hour';
$$;

SELECT cron.schedule(
  'cleanup-rate-limit-counters-hourly',
  '0 * * * *',
  $$ SELECT public.cleanup_old_rate_limit_counters(); $$
);
