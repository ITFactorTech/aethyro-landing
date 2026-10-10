-- Visible missed-run history for scheduled routines -- closes the real
-- trust gap real pre-launch feedback flagged: a routine that silently
-- skips when credits run out previously only overwrote last_result with
-- a one-line note nobody saw unless they happened to open the app, with
-- zero notification and no way to tell "ran fine 10 times, skipped once"
-- from "has never worked." routine_run_log records every attempt
-- (completed/skipped_no_credits/error), not just the single most recent
-- one last_result already tracks.
create table public.routine_run_log (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.user_routines(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('completed','skipped_no_credits','error')),
  detail text,
  ran_at timestamptz not null default now()
);

comment on table public.routine_run_log is
  'Per-attempt run history for scheduled routines (completed/skipped_no_credits/error), supplementing user_routines.last_result with an actual history instead of one overwritten string. Written only by run-routines (service_role); read-only for the owning user.';

create index routine_run_log_routine_id_ran_at_idx on public.routine_run_log(routine_id, ran_at desc);

alter table public.routine_run_log enable row level security;

create policy routine_run_log_select_own on public.routine_run_log
  for select using (user_id = auth.uid());

-- Default-privileges grant is a floor here, not a ceiling (see CLAUDE.md's
-- schema-gotchas section) -- revoke the automatic over-grant explicitly
-- before the narrow re-grant, same discipline as every other table in
-- this project. No INSERT/UPDATE/DELETE grant for authenticated at all:
-- this table is written only by run-routines' own service-role client,
-- which bypasses RLS/grants as service_role, never by the client directly.
revoke all on public.routine_run_log from public, anon, authenticated;
grant select on public.routine_run_log to authenticated;

-- Lightweight retention, same shape as cleanup_old_trial_usage() /
-- cleanup_old_rate_limit_counters(): service_role-only, scheduled via
-- pg_cron (which runs as a superuser role that bypasses grants entirely,
-- same reasoning already applied to this project's other cleanup jobs).
create or replace function public.cleanup_old_routine_run_log()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.routine_run_log where ran_at < now() - interval '90 days';
$$;

revoke all on function public.cleanup_old_routine_run_log() from public, anon, authenticated;
grant execute on function public.cleanup_old_routine_run_log() to service_role;

select cron.schedule(
  'cleanup-routine-run-log-daily',
  '30 3 * * *',
  $cron$select public.cleanup_old_routine_run_log();$cron$
);
