-- newsletter_reactions was backfilled on 2026-10-09 (migration
-- 20261009021342_newsletter_reactions.sql) without the explicit
-- `REVOKE ALL ... FROM anon, authenticated` this project's every other
-- table uses before a narrow re-grant -- it relied on RLS alone. Found by
-- the backend-reviewer sweep-mode review dispatched by site-guardian's
-- first restructured sweep, 2026-10-12: anon/authenticated both held the
-- project's default-privileges floor (SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE/REFERENCES/TRIGGER), not just SELECT. Not currently
-- exploitable -- the table's only INSERT policy is WITH CHECK (false),
-- and there is no UPDATE/DELETE policy at all, so both commands are
-- implicitly denied under RLS regardless of the table grant -- but it's
-- the same recurring grant-floor pattern already documented for
-- api_keys/routine_webhooks/get_credit_balance, so closing it here too.
-- Writes correctly continue through add_newsletter_reaction(), which is
-- SECURITY DEFINER and bypasses table grants entirely (owned by the
-- migration-running role), so a client-side public read is the only
-- thing this table's grants need to support.

revoke all on public.newsletter_reactions from public, anon, authenticated;
grant select on public.newsletter_reactions to anon, authenticated;
