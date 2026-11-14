-- Keep the one-time human-check token out of the stored user row.
--
-- The signup-gate auth hook needs the Cloudflare Turnstile token, and the hook
-- payload does not carry Supabase's own captchaToken, so signup.html sends it as
-- user_metadata.cf_turnstile_token. The token is single-use and worthless once the
-- hook has accepted it, but if it were stored it would ride in the user's
-- user_metadata claim in EVERY JWT for the life of the account (up to ~2 KB of dead
-- weight on each request). This BEFORE INSERT trigger removes the key from the row
-- before it is written; the hook has already run by then, and the AFTER INSERT
-- triggers (profile, signup bonus, referral code, emails) never read the key.
--
-- Harmless when nothing sends the key: the trigger is a no-op without it.
CREATE OR REPLACE FUNCTION public.strip_signup_human_check_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.raw_user_meta_data ? 'cf_turnstile_token' THEN
    NEW.raw_user_meta_data := NEW.raw_user_meta_data - 'cf_turnstile_token';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are not meant to be called directly; this project's default
-- privileges would otherwise leave EXECUTE on anon/authenticated.
REVOKE ALL ON FUNCTION public.strip_signup_human_check_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.strip_signup_human_check_token() TO service_role;

DROP TRIGGER IF EXISTS aa_strip_signup_human_check_token ON auth.users;
CREATE TRIGGER aa_strip_signup_human_check_token
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.strip_signup_human_check_token();
