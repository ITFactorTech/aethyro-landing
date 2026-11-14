-- The human-check token was still being stored: strip it on UPDATE as well.
--
-- 20261114200000 removes user_metadata.cf_turnstile_token with a BEFORE INSERT trigger. The
-- first real email signup after the human check went live (2026-11-14 18:33Z) showed the
-- token (730 characters) still in raw_user_meta_data. Supabase Auth inserts the user and then
-- writes the whole row again from its in-memory copy (updated_at is ~1.2 s after created_at;
-- it sets the confirmation token and sent-at there), and that second write puts the key back.
-- Verified only by a direct INSERT before, which never sees that second write.
--
-- Effect of leaving it: the (single-use, already consumed) token rides in the user_metadata
-- claim of every JWT for that account, ~730 bytes of dead weight on every request. Harmless
-- for security, wasteful, and worth removing.
--
-- Fix: fire on UPDATE too, only when the key is present (the WHEN clause keeps ordinary
-- updates, such as last_sign_in_at, from running the function at all). Then clean up the rows
-- that already have it. The function body is unchanged.
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

REVOKE ALL ON FUNCTION public.strip_signup_human_check_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.strip_signup_human_check_token() TO service_role;

DROP TRIGGER IF EXISTS aa_strip_signup_human_check_token ON auth.users;
CREATE TRIGGER aa_strip_signup_human_check_token
  BEFORE INSERT OR UPDATE ON auth.users
  FOR EACH ROW
  WHEN (NEW.raw_user_meta_data ? 'cf_turnstile_token')
  EXECUTE FUNCTION public.strip_signup_human_check_token();

-- Existing rows: the update fires the trigger, which removes the key.
UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data
WHERE raw_user_meta_data ? 'cf_turnstile_token';
