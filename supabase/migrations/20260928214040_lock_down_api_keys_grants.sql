-- Fixes a real grant bug found live while verifying 20260928100000's
-- api_keys table: this project auto-grants full ALL-privilege table access
-- to anon/authenticated via a default-privileges rule that fires on every
-- new table in public (same class of gotcha CLAUDE.md already documents
-- for column-scoped grants, but the table-level version -- a GRANT is
-- additive, never restrictive, so the earlier migration's column-scoped
-- `GRANT SELECT (id, name, ...)` never actually narrowed anything: the
-- broader default-privilege grant underneath it still gave authenticated
-- full-table SELECT (key_hash included), INSERT, and UPDATE, and gave
-- anon SELECT and INSERT too.
--
-- Confirmed live before this fix: has_table_privilege('authenticated',
-- 'public.api_keys', 'INSERT'/'UPDATE') both true, has_table_privilege
-- ('anon', 'public.api_keys', 'SELECT'/'INSERT') both true, and a real
-- authenticated session's raw REST call for `select=id,key_hash` returned
-- the real hash for a still-live key.
--
-- Practical exploit surface here was narrow (RLS's `auth.uid() = user_id`
-- check still blocks anon's INSERT -- auth.uid() is null for anon, and
-- `null = anything` is never true -- and an authenticated user directly
-- INSERT/UPDATE-ing their own row can only affect their own account's
-- billing path, not another user's), but key_hash being client-readable
-- at all defeats the point of hashing it, and letting a client bypass
-- create_api_key() to self-INSERT a row breaks the "only that function
-- generates a key" invariant the design relies on. Revoking and
-- re-granting narrowly, rather than trusting a downstream column grant to
-- override a broader upstream one, since it doesn't.
REVOKE ALL ON public.api_keys FROM authenticated, anon;
GRANT SELECT (id, name, key_prefix, created_at, last_used_at, request_count), DELETE
  ON public.api_keys TO authenticated;
