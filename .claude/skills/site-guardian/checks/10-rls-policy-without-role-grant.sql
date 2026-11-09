-- Check: an RLS policy names a role (anon/authenticated) that has no matching
-- table- or column-level GRANT for the policy's command, so the policy is dead.
--
-- First found by: shared-conversation links (app/share.html), 2026-11-09.
-- The 2026-10-09 migration added "anon can read shared conversations" and
-- "anon can read shared messages" (SELECT, role anon) but anon never held
-- SELECT on conversations/messages, so every logged-out visitor to a share
-- link got the error page — for ~1 month, with 2 real shared conversations
-- affected. A non-owner signed-in viewer was blocked too (no authenticated
-- policy for shared rows). Same class as routines_public_read (2026-09-28):
-- PostgREST checks the table-level GRANT first, and a policy cannot grant
-- what the role was never granted. Neither a grants review nor a policy
-- review catches it alone — it needs the join.
--
-- Run via execute_sql. Clean result: zero rows.
--
-- A row is a finding in one of two directions — decide which, don't just
-- grant: (a) the policy is the intent and a grant is missing -> but first ask
-- whether the policy is safe to expose (a USING that only tests a column such
-- as `share_token IS NOT NULL` lets the role ENUMERATE every matching row, so
-- prefer a SECURITY DEFINER RPC keyed on the secret token); or (b) the grant
-- was deliberately withheld and the policy is leftover -> drop the policy so a
-- future broad GRANT cannot silently expose rows.

with pol as (
  select schemaname, tablename, policyname, cmd, unnest(roles::text[]) as role
  from pg_policies where schemaname = 'public' and permissive = 'PERMISSIVE'
),
need as (
  select *, case cmd when 'ALL' then array['SELECT','INSERT','UPDATE','DELETE'] else array[cmd] end as privs from pol
)
select n.tablename, n.policyname, n.cmd, n.role, p as missing_priv
from need n cross join lateral unnest(n.privs) p
where n.role in ('anon', 'authenticated')
  and not has_table_privilege(n.role, format('%I.%I', n.schemaname, n.tablename), p)
  and not exists (
    select 1 from information_schema.column_privileges cp
    where cp.table_schema = n.schemaname and cp.table_name = n.tablename
      and cp.grantee = n.role and cp.privilege_type = p)
order by 1, 2, 4;

-- Note: policies written `TO public` expand to no row here (roles = {public})
-- on purpose — they are usually "own rows" ALL policies where only the
-- authenticated half is meant to work; judge those by reading them.
