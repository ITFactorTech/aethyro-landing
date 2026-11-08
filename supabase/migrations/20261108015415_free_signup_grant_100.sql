-- Free signup grant 200 -> 100 credits (2026-11-08). Only the amount changes:
-- the bonus_blocked_domains skip, SECURITY DEFINER and search_path are exactly
-- as in 20261107170422_bonus_blocked_domains.sql. Existing accounts and their
-- balances are untouched; this only affects signups from now on. The grants on
-- the function are unchanged (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION public.grant_signup_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bonus_blocked_domains d
    WHERE d.domain = lower(split_part(NEW.email, '@', 2))
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.credit_ledger (user_id, delta, reason)
  VALUES (NEW.id, 100, 'signup_bonus');
  RETURN NEW;
END;
$function$;
