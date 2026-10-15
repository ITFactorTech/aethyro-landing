-- Formalizes public.provider_health, the circuit-breaker table for the
-- multi-provider LLM failover (supabase/functions/_shared/llm.ts). The
-- table already existed live (created out-of-band, 2026-10-13, see
-- CLAUDE.md's "Pending" history) with zero migration behind it -- this
-- backfills that gap with the real live column shape, confirmed via
-- information_schema before writing this file. CREATE TABLE IF NOT
-- EXISTS makes this safe to apply regardless of whether the live table
-- already exists.
--
-- Same zero-client-access, service-role-only posture as every other
-- internal-state table in this project (rate_limit_counters,
-- app_secrets): only chat/trial-chat's own supaAdmin client ever reads
-- or writes this, via completeWithFailover() -- never a direct client
-- query. Locked down from the start this time, not found-and-fixed
-- later, unlike this project's own repeated history of that exact gap.

create table if not exists public.provider_health (
  provider              text primary key,
  consecutive_failures  integer not null default 0,
  opened_until          timestamptz
);

alter table public.provider_health enable row level security;

revoke all on public.provider_health from public, anon, authenticated;

insert into public.provider_health (provider, consecutive_failures, opened_until)
values ('anthropic', 0, null), ('openai', 0, null)
on conflict (provider) do nothing;
