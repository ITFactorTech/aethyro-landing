-- The public routines gallery (routines.html, new top-level marketing page)
-- needs logged-out visitors to read public routines directly via the anon
-- key. The routines_public_read RLS policy (is_public = true) already
-- exists and is correctly scoped -- but PostgREST checks the table-level
-- GRANT before RLS ever runs, and anon had INSERT/UPDATE/DELETE/TRUNCATE/
-- REFERENCES/TRIGGER on user_routines with no SELECT at all. That's why
-- the in-app "Community Gallery" in chat.html (added by
-- 20260927030000_forkable_routines.sql) only ever worked signed-in: it
-- never actually exercised the anon path this migration fixes. Found live
-- while building routines.html: an anon-key SELECT against this table
-- returned a bare 401, confirmed via information_schema.role_table_grants
-- that anon had every other privilege except SELECT.
--
-- Column-scoped rather than a blanket table GRANT: anon can only ever read
-- the columns the public gallery actually needs (id, name, prompt,
-- schedule, model, fork_count, is_public) -- never user_id, forked_from,
-- enabled, or created_at, even via a crafted PostgREST query. is_public
-- must be included even though the client never selects it: Postgres
-- column-level SELECT grants must cover every column referenced anywhere
-- in the query, including WHERE clauses and RLS USING expressions, not
-- just the output column list -- the first version of this migration
-- omitted it and the live query failed with 42501 "permission denied for
-- table user_routines" until this was added. RLS's is_public = true
-- filter is still the real row-level boundary; this grant only clears the
-- table/column-level check that was blocking it from ever being reached.

GRANT SELECT (id, name, prompt, schedule, model, fork_count, is_public)
  ON public.user_routines
  TO anon;
