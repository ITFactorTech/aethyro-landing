-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- Credit ledger: append-only record of credit purchases and chat usage.
-- 1 credit = $0.01 of retail value. Balance is always derived by summing
-- deltas (never a mutable column), so there's no drift to reconcile.
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason text not null check (reason in ('purchase','chat_usage','signup_bonus','admin_adjustment')),
  stripe_session_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index credit_ledger_user_id_idx on public.credit_ledger (user_id);

alter table public.credit_ledger enable row level security;

create policy "users can view their own ledger"
  on public.credit_ledger
  for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for anon/authenticated: credits are only
-- ever written by edge functions using the service role key, so a user can
-- never grant themselves a balance.

create or replace function public.get_credit_balance()
returns integer
language sql
stable
security invoker
set search_path to ''
as $$
  select coalesce(sum(delta), 0)::integer
  from public.credit_ledger
  where user_id = auth.uid();
$$;

grant execute on function public.get_credit_balance() to authenticated;

-- Extend the existing signup handler to grant a small free credit bonus
-- (200 credits = $2) so new users can try the browser chat immediately.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;

  insert into public.subscriptions (user_id, plan, status, trial_ends_at)
    values (new.id, 'trial', 'trialing', now() + interval '14 days')
    on conflict (user_id) do nothing;

  insert into public.credit_ledger (user_id, delta, reason)
    values (new.id, 200, 'signup_bonus');

  return new;
end;
$function$;
