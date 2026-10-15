-- Found by the restructured site-guardian orchestrator's consolidated sweep,
-- 2026-10-15 (serialized advisors check): two tables carried this project's
-- recurring default-privileges grant-floor bug -- full ALL-privilege grants
-- to anon/authenticated (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
-- TRIGGER) that were never explicitly revoked when the table was created.
-- Same class already documented multiple times for api_keys/
-- routine_webhooks/newsletter_reactions/get_credit_balance.
--
-- Neither is currently exploitable:
--   - `teams` (added by PR #100, team credit pooling) has exactly one RLS
--     policy, `teams_select_member` (SELECT only, scoped to
--     owner_id = auth.uid() OR team membership via profiles.team_id) -- so
--     INSERT/UPDATE/DELETE were already implicitly denied for everyone
--     (no matching policy = deny, regardless of the raw grant). All
--     mutations correctly go through team-manage's service-role client,
--     confirmed via repo-wide grep: no client code anywhere calls
--     supabase.from('teams') directly.
--   - `email_drip_state` has exactly one RLS policy, "service role only"
--     (cmd ALL, qual false) -- every command is denied to every role
--     except a BYPASSRLS role (service_role), regardless of grants.
--     Confirmed via grep this table has zero client-facing read/write path;
--     only send-welcome-email and the drip pg_cron jobs touch it, both via
--     service-role/net.http_post.
--
-- Locking down anyway for the same least-privilege discipline applied
-- everywhere else in this project.

revoke all on public.teams from public, anon, authenticated;
grant select on public.teams to authenticated;

revoke all on public.email_drip_state from public, anon, authenticated;
