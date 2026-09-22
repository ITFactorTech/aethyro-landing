-- Deletes trial_usage rows older than 24 hours, keeping the table small.
-- Called by the daily pg_cron job.

CREATE OR REPLACE FUNCTION public.cleanup_old_trial_usage()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.trial_usage
  WHERE created_at < now() - interval '24 hours';
$$;

-- Backfill: remove stale rows that predate created_at tracking
-- (rows inserted before the column existed have DEFAULT now(), so
--  this is a no-op in practice, but is safe to run).
SELECT public.cleanup_old_trial_usage();
