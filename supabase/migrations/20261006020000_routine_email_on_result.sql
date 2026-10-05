-- Feature: return-visit hook, part 1 -- actually notify the user when a
-- scheduled routine produces a result, instead of it running completely
-- silently in the background (today the only way to see a result is to
-- open the app and look at the Routines tab). Real data motivating this
-- (CLAUDE.md, 2026-10-05): 1 routine ever created, never run, 89% of
-- users who ever opened a chat never returned on a second day. A routine
-- that quietly runs in the background gives a user zero reason to come
-- back and look -- an email does.

alter table public.user_routines
  add column if not exists email_on_result boolean not null default false;

comment on column public.user_routines.email_on_result is
  'When true, run-routines emails the owner a short summary after each successful run (cron-fired, webhook-fired, chained, or a manual Run Now) via send-routine-result-email. Owner-writable like is_public/enabled -- no new RLS policy needed, covered by the existing routines_own ALL policy.';
