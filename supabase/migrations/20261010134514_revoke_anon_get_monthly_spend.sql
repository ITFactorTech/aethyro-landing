-- REVOKE ALL ... FROM PUBLIC in the preceding migration did not remove
-- anon's own separate, earlier explicit grant (same default-privileges-
-- is-a-floor pattern this project has hit repeatedly -- see CLAUDE.md).
-- Confirmed live via has_function_privilege before fixing: anon could
-- execute get_monthly_spend(uuid) directly. Harmless in practice (anon's
-- auth.uid() is null, so the ownership check inside always raises
-- Forbidden for anon regardless), but revoked by name for the same
-- least-privilege discipline this project applies everywhere else.
revoke all on function public.get_monthly_spend(uuid) from anon;
