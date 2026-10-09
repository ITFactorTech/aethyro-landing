-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Remove any existing job with the same name before re-creating
SELECT cron.unschedule('cleanup-trial-usage-daily')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'cleanup-trial-usage-daily'
);

-- Schedule daily at 03:00 UTC
SELECT cron.schedule(
  'cleanup-trial-usage-daily',
  '0 3 * * *',
  $$ SELECT public.cleanup_old_trial_usage(); $$
);
