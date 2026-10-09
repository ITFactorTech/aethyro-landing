-- Fixes: every new signup was granted the 200-credit signup bonus TWICE.
--
-- Root cause: two independent triggers on auth.users both grant it.
-- `on_auth_user_created` -> handle_new_user() is an old trigger that
-- predates this repo's migration history entirely (not defined in any
-- committed migration -- it must have been created directly via the
-- Supabase dashboard/SQL editor at some point). It already inserts a
-- `credit_ledger` signup_bonus row, and also inserts into `subscriptions`
-- (the decommissioned per-plan model -- see the "Decommissioned" section
-- in CLAUDE.md; nothing reads that table anymore, dashboard.html hardcodes
-- "Pay-as-you-go"). Then 20260901000001_auto_grant_signup_bonus.sql added
-- a SECOND trigger, on_auth_user_created_grant_bonus -> grant_signup_bonus(),
-- doing the exact same credit grant -- apparently without knowing
-- handle_new_user() already did this job, since it isn't in this repo.
--
-- Net effect since 2026-09-01: every real new signup gets 400 credits
-- instead of 200. Checked live before writing this migration: zero real
-- users have signed up since that date (only 2 real accounts exist total,
-- both predate the second trigger, neither double-credited) -- this was a
-- live bug with no actual victims yet, not something needing balance
-- correction for existing users.
--
-- Fix: keep on_auth_user_created / handle_new_user() only for what nothing
-- else does -- the `profiles` insert (referral_codes generation depends on
-- a row existing there, per a trigger on profiles INSERT). Drop the
-- duplicate credit_ledger grant (grant_signup_bonus() already owns that)
-- and drop the dead subscriptions insert.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  insert into public.profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;

  return new;
end;
$function$;
