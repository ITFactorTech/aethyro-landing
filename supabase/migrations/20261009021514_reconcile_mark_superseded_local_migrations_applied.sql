-- Bookkeeping-only: marks local migration files whose net effect is already
-- live (via different, already-applied real migrations, or via a since-
-- superseded first draft of the same change) as "applied" in Supabase's own
-- migration-history table, WITHOUT running their SQL. This is the direct
-- SQL equivalent of `supabase migration repair --status applied <version>`.
--
-- Done as part of the 2026-10-09 migration-history reconciliation (see
-- CLAUDE.md). Each of these 16 local files has a version number that was
-- never tracked remotely -- without this, a future `supabase db push`
-- would try to execute them for real, which for at least one of them
-- (20260901000002, an old pre-hardening get_credit_balance with no
-- ownership check) would silently regress a documented security fix.
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260901000001', 'auto_grant_signup_bonus'),
  ('20260901000002', 'credit_balance_function_and_view'),
  ('20260901000003', 'trial_usage_cleanup_function'),
  ('20260901000004', 'schedule_trial_usage_cleanup_cron'),
  ('20260901000005', 'security_and_performance_hardening'),
  ('20260901000007', 'lock_down_function_execute_grants'),
  ('20260901000008', 'stripe_webhook_cancelled_spelling_fix'),
  ('20260901000009', 'get_credit_balance_security_invoker'),
  ('20260924000005', 'conversation_history'),
  ('20260924000008', 'intelligence_upgrade'),
  ('20260925000001', 'security_hardening'),
  ('20260926000004', 'admin_user_management'),
  ('20260927234300', 'harden_trigger_welcome_email'),
  ('20260928040000', 'grant_anon_select_public_routines'),
  ('20260928060000', 'team_credit_pool'),
  ('20261003210000', 'lock_down_cleanup_rate_limit_counters')
on conflict (version) do nothing;
