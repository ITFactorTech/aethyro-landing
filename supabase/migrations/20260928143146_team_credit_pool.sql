-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles
  ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE public.credit_ledger
  ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY teams_select_member ON public.teams FOR SELECT
  USING (
    owner_id = auth.uid()
    OR id = (SELECT team_id FROM public.profiles WHERE id = auth.uid())
  );

GRANT SELECT ON public.teams TO authenticated;

CREATE OR REPLACE FUNCTION public.lookup_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM auth.users WHERE email = p_email LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.lookup_user_id_by_email(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(cl.delta), 0)::integer
  FROM public.credit_ledger cl
  WHERE
    (
      (SELECT team_id FROM public.profiles WHERE id = p_user_id) IS NOT NULL
      AND cl.team_id = (SELECT team_id FROM public.profiles WHERE id = p_user_id)
    )
    OR (
      (SELECT team_id FROM public.profiles WHERE id = p_user_id) IS NULL
      AND cl.user_id = p_user_id
      AND cl.team_id IS NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT public.get_credit_balance(auth.uid());
$$;