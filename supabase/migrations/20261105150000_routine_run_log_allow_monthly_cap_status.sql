-- Allow 'skipped_monthly_cap' in routine_run_log.status.
--
-- PR #211 (55373a1) extended the opt-in monthly spend cap to run-routines: a
-- routine whose owner has already hit their cap is skipped, and run-routines
-- writes a routine_run_log row with status 'skipped_monthly_cap' so the skip
-- is distinguishable from 'skipped_no_credits' in the History view. But
-- routine_run_log_status_check (20261010233902_routine_run_log.sql) only
-- allows ('completed','skipped_no_credits','error'), so every such insert
-- violates the CHECK (23514). run-routines never checked that insert's
-- error, so the skip itself still worked (user_routines.last_result is
-- updated first) but the history row was silently never written.
--
-- Same bug class as the credit_ledger.reason / CHECK-constraint-literal
-- incidents documented in CLAUDE.md (run-routines / run-agent-task billing,
-- 2026-09-28): a new status literal must be added to the CHECK in the same
-- change that starts writing it. Not yet live-impacting (zero profiles have
-- monthly_spend_cap_credits set as of 2026-11-05), but it would surface the
-- first time any user with a cap and a routine hits that cap.

ALTER TABLE public.routine_run_log
  DROP CONSTRAINT IF EXISTS routine_run_log_status_check;

ALTER TABLE public.routine_run_log
  ADD CONSTRAINT routine_run_log_status_check
  CHECK (status IN ('completed', 'skipped_no_credits', 'skipped_monthly_cap', 'error'));

COMMENT ON TABLE public.routine_run_log IS
  'Per-attempt run history for scheduled routines (completed/skipped_no_credits/skipped_monthly_cap/error), supplementing user_routines.last_result with an actual history instead of one overwritten string. Written only by run-routines (service_role); read-only for the owning user.';
