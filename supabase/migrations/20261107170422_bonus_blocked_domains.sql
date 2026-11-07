-- Exact-domain blocklist for the free signup bonus (and referral bonuses).
-- Seeded with fldubai.com: confirmed scripted farming (warden, 2026-11-07).
-- Zero-client-access table: RLS on, no policies, no anon/authenticated grants.
CREATE TABLE IF NOT EXISTS public.bonus_blocked_domains (
  domain     text PRIMARY KEY CHECK (domain = lower(domain) AND domain !~ '\s' AND position('@' in domain) = 0),
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.bonus_blocked_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bonus_blocked_domains FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bonus_blocked_domains TO service_role;

INSERT INTO public.bonus_blocked_domains (domain, reason)
VALUES ('fldubai.com', 'Scripted signup-bonus/API-key farming, confirmed by warden 2026-11-05 and 2026-11-07 (31 accounts, utm_source=autoreg, 27 API-key minters, 1 stored conversation).')
ON CONFLICT (domain) DO NOTHING;

-- Same body as before, plus: skip the bonus when the new user's email domain
-- is on the blocklist. The profile/referral_code triggers are untouched, so
-- signup itself still succeeds; only the free 200 credits are withheld.
-- CREATE OR REPLACE keeps the existing (locked-down) EXECUTE grants.
CREATE OR REPLACE FUNCTION public.grant_signup_bonus()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bonus_blocked_domains d
    WHERE d.domain = lower(split_part(NEW.email, '@', 2))
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.credit_ledger (user_id, delta, reason)
  VALUES (NEW.id, 200, 'signup_bonus');
  RETURN NEW;
END;
$$;
