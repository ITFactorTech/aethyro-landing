-- Team accounts, scope: shared credit pool only (explicit user choice —
-- conversations, documents, and memory stay private per-user; only the
-- credit balance is shared). Smallest-surface design:
--   - `teams`: id, name, owner_id, created_at. No member-role column — the
--     only distinction is owner_id vs. everyone else on the team.
--   - `profiles.team_id`: nullable FK. A user belongs to at most one team.
--     Deliberately NOT in authenticated's UPDATE grant (see below) — it can
--     only be set by team-manage/index.ts (service role), never directly
--     by a client, so a user can never join a team by guessing/knowing its
--     id. Client-writable would be a real privilege-escalation path onto
--     someone else's credit pool.
--   - `credit_ledger.team_id`: nullable FK, stamped on new chat_usage/
--     purchase rows going forward by chat/stripe-webhook/auto-topup-charge
--     based on the acting user's current team_id at insert time. Existing
--     rows are never backfilled/rewritten -- a user's history before ever
--     joining a team stays theirs and becomes visible again if they leave.
--   - get_credit_balance (both overloads) becomes team-pool-aware: sums by
--     team_id when the user is on a team, otherwise by user_id (with
--     team_id IS NULL, so a former team member's personal balance excludes
--     rows that were actually pooled activity).
-- No team deletion/disband action exists yet (see team-manage/index.ts) --
-- deliberately out of scope for this pass, since "where does the leftover
-- pool balance go" is a real product decision, not a technical one. Only
-- create/invite/remove/leave/list are supported; a team with no owner
-- action taken just persists.

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

-- A user can read a team's row only if they're currently on it or they're
-- its owner (the latter matters if an owner ever leaves their own team --
-- see the note in team-manage/index.ts about that edge case).
CREATE POLICY teams_select_member ON public.teams FOR SELECT
  USING (
    owner_id = auth.uid()
    OR id = (SELECT team_id FROM public.profiles WHERE id = auth.uid())
  );

-- No INSERT/UPDATE/DELETE grant for authenticated at all -- every mutation
-- goes through team-manage/index.ts (service role), which is where the
-- actual authorization logic (owner-only invite/remove, self-only leave)
-- lives. SELECT is grant + RLS as usual.
GRANT SELECT ON public.teams TO authenticated;

-- Exact-match email -> user id lookup for the invite flow. auth.users isn't
-- queryable via PostgREST at all, and supabase-js's admin API has no
-- getUserByEmail in this project's client version -- this is the minimal,
-- narrowly-scoped way to resolve one. SECURITY DEFINER, service-role-only:
-- never grant this to anon/authenticated, since it would let any signed-in
-- user probe whether an arbitrary email has an Aethyro account.
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

-- SECURITY DEFINER is required here, not optional: credit_ledger's only
-- SELECT policy is "users can view their own ledger" (user_id = auth.uid()).
-- A plain SECURITY INVOKER function summing WHERE team_id = X would have
-- that RLS policy ANDed underneath its own WHERE clause, silently limiting
-- a team member's aggregate to only the ledger rows *they themselves*
-- created — found live while testing: two real throwaway accounts on the
-- same team saw different balances (100 vs 0) until this was added, because
-- the non-owner's query could only see their own rows, not the other
-- member's. SECURITY DEFINER bypasses that correctly here because this
-- function only ever returns a single aggregate integer, never raw rows,
-- so it can't leak any other member's individual transaction details.
--
-- The two overloads are granted very differently on purpose: the 0-arg
-- overload (resolves auth.uid() internally) is safe for any authenticated
-- user to call, since it can only ever compute *their own* balance. The
-- (uuid) overload must NEVER be grantable to authenticated directly —
-- combined with SECURITY DEFINER, that would let any signed-in user pass
-- an arbitrary other user's id and read their exact balance. It's
-- service-role-only, called by edge functions (chat, stripe-webhook,
-- auto-topup-charge) that already trust their own p_user_id argument.
CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
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
-- REVOKE ALL FROM PUBLIC does not remove a role's own *explicit* grant --
-- anon had one here from this function's original (pre-team) definition,
-- so it's revoked from anon by name too. Confirmed live with an
-- unauthenticated curl before this line existed: a bare anon-key request
-- passing an arbitrary uuid successfully returned that user's exact
-- balance. Fixed and reconfirmed denied (42501) before this migration
-- file was finalized.
REVOKE ALL ON FUNCTION public.get_credit_balance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_credit_balance(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_credit_balance()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.get_credit_balance(auth.uid());
$$;
REVOKE ALL ON FUNCTION public.get_credit_balance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_credit_balance() TO authenticated;
