-- site-guardian sweep 2026-10-18: decision_centroids (added in PR #183,
-- migration 20261017224646_decision_centroids.sql) was locked down via
-- table-level REVOKE/GRANT but never had RLS enabled at all -- unlike
-- every sibling zero-client-access table in this project (admin_users,
-- agent_missions, app_secrets, model_router_centroids, provider_health,
-- purchase_funnel_events, rate_limit_counters, testimonials), all of
-- which enable RLS with zero policies as a defense-in-depth backstop.
-- Not currently exploitable (no role but service_role/postgres holds any
-- grant on this table regardless), but it's a real deviation from this
-- repo's own established pattern for this exact table class: without RLS
-- enabled, a future accidental GRANT to anon/authenticated would have no
-- second layer catching it, whereas every sibling table's zero-policy RLS
-- would still correctly deny all rows even if its grants were loosened by
-- mistake. Matches the pattern now.

alter table public.decision_centroids enable row level security;
