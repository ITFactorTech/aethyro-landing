-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

create table if not exists public.trial_usage (
  ip_address text not null,
  day date not null,
  count integer not null default 0,
  primary key (ip_address, day)
);

alter table public.trial_usage enable row level security;
-- no policies: only the service role (used by the trial-chat edge function) touches this table,
-- and the service role bypasses RLS. No client role should ever read or write it directly.

create or replace function public.increment_trial_usage(p_ip text, p_day date)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  new_count integer;
begin
  insert into public.trial_usage (ip_address, day, count)
  values (p_ip, p_day, 1)
  on conflict (ip_address, day)
  do update set count = public.trial_usage.count + 1
  returning count into new_count;
  return new_count;
end;
$$;