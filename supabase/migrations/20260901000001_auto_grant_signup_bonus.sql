-- Automatically grants 200 credits to every new user on signup.
-- Also backfills any existing users who joined before this trigger existed.

CREATE OR REPLACE FUNCTION public.grant_signup_bonus()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.credit_ledger (user_id, delta, reason)
  VALUES (NEW.id, 200, 'signup_bonus');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_grant_bonus ON auth.users;
CREATE TRIGGER on_auth_user_created_grant_bonus
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.grant_signup_bonus();

-- Backfill users who signed up before this trigger was added
INSERT INTO public.credit_ledger (user_id, delta, reason)
SELECT u.id, 200, 'signup_bonus'
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.credit_ledger cl
  WHERE cl.user_id = u.id AND cl.reason = 'signup_bonus'
);
