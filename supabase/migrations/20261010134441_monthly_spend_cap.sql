-- Monthly spend cap -- the single most-repeated ask from real pre-launch
-- feedback (three separate commenters converged on "a ceiling is what
-- turns metered pricing from scary to usable"). Lets a user set a hard
-- credit ceiling per UTC calendar month; chat's pre-send gate blocks a
-- message whose worst-case cost would push them over it, rather than
-- silently billing past a limit the user set for themselves.
-- Scoped to the individual user's own ledger rows, not the team-pooled
-- balance get_credit_balance() understands -- the cap is a personal
-- safety rail on one person's own spend rate, not a team-wide policy;
-- extending it to teams is a real but separate, not-yet-asked-for scope.
alter table public.profiles
  add column monthly_spend_cap_credits integer
    check (monthly_spend_cap_credits is null or monthly_spend_cap_credits >= 0);

comment on column public.profiles.monthly_spend_cap_credits is
  'Optional hard ceiling (credits) on this user''s own spend per UTC calendar month. NULL = no cap. Client-settable; enforced server-side in chat''s pre-send gate against get_monthly_spend(). Personal, not team-pooled.';

-- authenticated already has blanket table-level SELECT on profiles; UPDATE
-- is column-scoped in this project (see CLAUDE.md), so this needs its own
-- explicit grant, same pattern as auto_topup_pack.
grant update (monthly_spend_cap_credits) on public.profiles to authenticated;

create or replace function public.get_monthly_spend(p_user_id uuid)
returns integer
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if auth.role() <> 'service_role' and auth.uid() is distinct from p_user_id and not public.is_admin() then
    raise exception 'Forbidden';
  end if;

  return (
    select coalesce(sum(-cl.delta), 0)::integer
    from public.credit_ledger cl
    where cl.user_id = p_user_id
      and cl.delta < 0
      and cl.created_at >= date_trunc('month', now())
  );
end;
$function$;

revoke all on function public.get_monthly_spend(uuid) from public;
grant execute on function public.get_monthly_spend(uuid) to authenticated, service_role;
