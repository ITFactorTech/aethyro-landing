-- Drop 4 functions and 8 tables belonging to an unrelated genetic-algorithm/
-- agent-simulation project (agents/species/auctions/trades/economy) that
-- happened to share this Supabase project. Found by a site-guardian sweep
-- on 2026-09-27, dropped 2026-09-28 on explicit instruction.
--
-- Confirmed safe before dropping:
--  - all 8 tables had zero rows ever (pg_stat_user_tables.n_live_tup = 0)
--  - zero FK relationships to/from any Aethyro table (pg_constraint)
--  - zero references anywhere in this repo (grep)
--  - the 4 functions that reference these tables (get_leaderboard,
--    find_similar_agents, get_agent_trend, get_economy_summary) were
--    likewise unreferenced anywhere in this repo, despite being
--    EXECUTE-granted to `authenticated`

DROP FUNCTION IF EXISTS public.get_leaderboard(integer);
DROP FUNCTION IF EXISTS public.find_similar_agents(vector, integer);
DROP FUNCTION IF EXISTS public.get_agent_trend(text, integer);
DROP FUNCTION IF EXISTS public.get_economy_summary();

DROP TABLE IF EXISTS public.agent_fitness_history;
DROP TABLE IF EXISTS public.agent_events;
DROP TABLE IF EXISTS public.trades;
DROP TABLE IF EXISTS public.auctions;
DROP TABLE IF EXISTS public.economy_ticks;
DROP TABLE IF EXISTS public.agents;
DROP TABLE IF EXISTS public.species;
DROP TABLE IF EXISTS public.economy_config;
