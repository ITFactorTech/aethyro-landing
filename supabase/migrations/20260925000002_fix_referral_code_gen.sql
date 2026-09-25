-- Fix: generate_referral_code() used gen_random_bytes() which requires pgcrypto.
-- Replace with gen_random_uuid() which is always available in Supabase PostgreSQL.
-- Result is identical: an 8-char uppercase alphanumeric code with >4B combinations.

CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  new_code text;
  attempt  int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    IF attempt > 20 THEN RETURN NEW; END IF;
    -- gen_random_uuid() is always available; strip dashes and take 8 chars.
    new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    BEGIN
      INSERT INTO public.referral_codes (user_id, code) VALUES (NEW.id, new_code);
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      -- retry on collision
    END;
  END LOOP;
END;
$$;
