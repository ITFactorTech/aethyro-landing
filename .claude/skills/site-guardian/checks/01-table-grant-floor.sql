-- Check: a new/changed table's default-privilege grant to anon/authenticated
-- exceeds what its RLS policies were meant to allow.
--
-- First found by: api_keys leaking key_hash to any authenticated user,
-- 2026-09-28 (a column-scoped GRANT SELECT(...) is additive, never
-- restrictive — this project's default-privileges rule still hands
-- authenticated/anon broad table-level access underneath it unless there's
-- an explicit REVOKE ALL ... FROM authenticated, anon BEFORE the narrow
-- re-grant). Recurred since on routine_webhooks, user_integrations,
-- and purchase_funnel_events before each was fixed.
--
-- How to use: substitute <TABLE> with the table you're checking. Run for
-- every table created or granted-on since the sweep's cutoff timestamp.
-- A row appearing here for anon/authenticated that the table's own RLS
-- policies don't actually intend for that role is a finding — don't just
-- check "is this empty," read what's actually granted and compare it
-- against what the table's RLS USING clauses assume the role can do.

select
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = '<TABLE>'
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by grantee, privilege_type;

-- Clean result for a table meant to be fully locked down (no client write
-- path at all, e.g. agent_missions/admin_users-style): zero rows for
-- anon/authenticated/PUBLIC.
--
-- Clean result for an owner-scoped table (RLS USING auth.uid() = user_id):
-- authenticated has exactly the privileges its own CRUD flow needs
-- (usually SELECT/INSERT, sometimes UPDATE/DELETE) and nothing more;
-- anon has nothing unless the table has a genuine public-read policy
-- (e.g. user_routines.is_public), in which case anon should have SELECT
-- only, never INSERT/UPDATE/DELETE.
--
-- Mismatch: anon or authenticated holding a privilege (especially
-- UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) that no RLS policy on the
-- table actually uses for that role. Fix: REVOKE ALL ... FROM anon,
-- authenticated, then an explicit narrow GRANT matching real intent —
-- verify with this same query again before trusting the fix.
