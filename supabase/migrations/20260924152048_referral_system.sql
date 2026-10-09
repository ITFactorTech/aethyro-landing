-- Referral system: each user gets a unique 8-char code.
-- When a new user redeems a code, both parties get 100 bonus credits.
-- Enforced by the redeem-referral edge function; tables just store state.

-- referral_codes: one code per user, globally unique
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_codes_user_id_key  UNIQUE (user_id),
  CONSTRAINT referral_codes_code_key     UNIQUE (code)
);

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read own referral code"
  ON public.referral_codes FOR SELECT
  USING (auth.uid() = user_id);

-- referral_events: audit log; UNIQUE on referee so each user is referred at most once
CREATE TABLE IF NOT EXISTS public.referral_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id  uuid        NOT NULL REFERENCES auth.users(id),
  referee_user_id   uuid        NOT NULL REFERENCES auth.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_events_referee_key UNIQUE (referee_user_id)
);

ALTER TABLE public.referral_events ENABLE ROW LEVEL SECURITY;

-- Auto-generate a referral code whenever a profile is created
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  new_code text;
  attempt  int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    IF attempt > 20 THEN RETURN NEW; END IF;
    new_code := upper(substr(
      replace(replace(encode(gen_random_bytes(6), 'base64'), '/', 'X'), '+', 'Y'),
      1, 8
    ));
    BEGIN
      INSERT INTO public.referral_codes (user_id, code) VALUES (NEW.id, new_code);
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      -- retry on collision
    END;
  END LOOP;
END;
$$;

CREATE TRIGGER trg_generate_referral_code
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.generate_referral_code();

-- Backfill codes for existing users (uses id+timestamp hash to avoid collisions)
DO $$
DECLARE
  rec record;
  new_code text;
  attempt int;
BEGIN
  FOR rec IN
    SELECT id FROM public.profiles
    WHERE NOT EXISTS (SELECT 1 FROM public.referral_codes rc WHERE rc.user_id = profiles.id)
  LOOP
    attempt := 0;
    LOOP
      attempt := attempt + 1;
      IF attempt > 20 THEN EXIT; END IF;
      new_code := upper(substr(md5(rec.id::text || attempt::text), 1, 8));
      BEGIN
        INSERT INTO public.referral_codes (user_id, code) VALUES (rec.id, new_code);
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- retry
      END;
    END LOOP;
  END LOOP;
END;
$$;
