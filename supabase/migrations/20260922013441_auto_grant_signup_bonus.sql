-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Function: fires on every new auth.users insert, grants 200 credits
CREATE OR REPLACE FUNCTION public.grant_signup_bonus()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.credit_ledger (user_id, delta, reason)
  VALUES (NEW.id, 200, 'signup_bonus');
  RETURN NEW;
END;
$$;

-- Drop if exists, then re-create trigger
DROP TRIGGER IF EXISTS on_auth_user_created_grant_bonus ON auth.users;

CREATE TRIGGER on_auth_user_created_grant_bonus
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.grant_signup_bonus();

-- Backfill vikotaf450 who signed up but never got their bonus
INSERT INTO public.credit_ledger (user_id, delta, reason, created_at)
SELECT id, 200, 'signup_bonus', created_at
FROM auth.users
WHERE email = 'vikotaf450@gocoiny.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.credit_ledger cl
    WHERE cl.user_id = auth.users.id AND cl.reason = 'signup_bonus'
  );
