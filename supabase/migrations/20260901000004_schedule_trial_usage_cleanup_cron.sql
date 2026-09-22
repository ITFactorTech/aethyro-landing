-- Daily pg_cron job: clean up trial_usage rows older than 24 hours at 03:00 UTC.

SELECT cron.schedule(
  'cleanup-trial-usage-daily',
  '0 3 * * *',
  $$ SELECT public.cleanup_old_trial_usage(); $$
);
