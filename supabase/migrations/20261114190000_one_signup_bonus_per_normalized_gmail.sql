-- One signup bonus per Gmail mailbox.
--
-- Gmail ignores dots and anything after "+" in the local part, and treats
-- googlemail.com as gmail.com, so g.i.o.v.a.n.n.i@gmail.com and
-- giovanni+2@googlemail.com are all the same inbox. The 2026-11-02 sweep found 6
-- such accounts on one inbox (each collecting its own signup bonus), and the
-- cluster resumed on 2026-11-14 (two more, created in the same minute; 11 now).
-- Historically this rule would have affected no other account (warden, 2026-11-05).
--
-- What this changes: grant_signup_bonus() withholds the bonus when another
-- account on the same normalized Gmail address already received one. The account
-- itself is still created (signup, profile and referral-code triggers are
-- untouched), exactly like the existing blocked-domain rule. Only Gmail
-- addresses are normalized; every other domain is compared as-is, so a "+tag" on
-- Outlook or a company domain is NOT treated as a duplicate.
--
-- Concurrency: the farm scripts create pairs of accounts microseconds apart, and
-- each trigger runs in its own transaction, so neither would see the other's
-- uncommitted row. A transaction-scoped advisory lock keyed on the normalized
-- address serializes them: the second waits for the first to commit and then
-- sees its signup_bonus row.
--
-- Existing accounts and balances are not touched.

CREATE OR REPLACE FUNCTION public.normalize_email_for_dedupe(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE
    WHEN lower(split_part(p_email, '@', 2)) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(lower(split_part(p_email, '@', 1)), '+', 1), '.', '') || '@gmail.com'
    ELSE lower(p_email)
  END
$$;

-- A default-privileges rule in this project grants EXECUTE to anon/authenticated
-- by name; REVOKE ... FROM PUBLIC does not remove those. Only the trigger
-- (SECURITY DEFINER, owner postgres) and service_role need it.
REVOKE ALL ON FUNCTION public.normalize_email_for_dedupe(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_email_for_dedupe(text) TO service_role;

-- Same body as 20261108015415_free_signup_grant_100.sql (100 credits, blocked-domain
-- skip, SECURITY DEFINER, search_path) plus the Gmail rule. CREATE OR REPLACE keeps
-- the existing locked-down EXECUTE grants.
CREATE OR REPLACE FUNCTION public.grant_signup_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_norm text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bonus_blocked_domains d
    WHERE d.domain = lower(split_part(NEW.email, '@', 2))
  ) THEN
    RETURN NEW;
  END IF;

  IF lower(split_part(NEW.email, '@', 2)) IN ('gmail.com', 'googlemail.com') THEN
    v_norm := public.normalize_email_for_dedupe(NEW.email);
    PERFORM pg_advisory_xact_lock(hashtextextended('signup_bonus:' || v_norm, 0));
    IF EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id <> NEW.id
        AND lower(split_part(u.email, '@', 2)) IN ('gmail.com', 'googlemail.com')
        AND public.normalize_email_for_dedupe(u.email) = v_norm
        AND EXISTS (
          SELECT 1 FROM public.credit_ledger l
          WHERE l.user_id = u.id AND l.reason = 'signup_bonus'
        )
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.credit_ledger (user_id, delta, reason)
  VALUES (NEW.id, 100, 'signup_bonus');
  RETURN NEW;
END;
$$;
