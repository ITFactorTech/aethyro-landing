-- Check: every credit_ledger.reason literal actually used in committed
-- source has a matching entry in the live CHECK constraint, and vice
-- versa (a constraint entry with zero real usage is dead weight, worth
-- knowing but not a bug on its own).
--
-- First found by: run-routines/run-agent-task inserting reason:'routine'/
-- 'agent_task' rows that silently failed every single insert (23514 CHECK
-- violation) since either function was written, because the constraint
-- only ever listed purchase/chat_usage/signup_bonus/admin_adjustment/
-- referral_bonus. Neither function checked the insert's returned error,
-- so nothing surfaced it until a real task ran for free. Fixed 2026-09-28.
--
-- This check has two halves — one needs a repo grep (can't be pure SQL),
-- one is a live query. Run both.

-- Half 1 (grep, not SQL): find every reason literal actually used in
-- source.
--   grep -rhoE "reason\s*[:=]\s*['\"][a-z_]+['\"]" supabase/functions/ \
--     | grep -oE "['\"][a-z_]+['\"]" | tr -d "'\"" | sort -u

-- Half 2 (live query): pull the constraint's real allowed list.
select pg_get_constraintdef(oid) as constraint_definition
from pg_constraint
where conname = 'credit_ledger_reason_check';

-- Clean result: every literal from Half 1's grep output appears inside
-- Half 2's ARRAY[...] list.
--
-- Mismatch: a literal used in source but absent from the live constraint
-- list. Every insert using it has been silently failing (or will, the
-- first time that code path actually runs) — this is a real, live-impact
-- bug the moment it's found, not a style nit. Fix: extend the CHECK
-- constraint in the same migration as whatever feature introduces the new
-- reason value — never ship the feature first and the constraint update
-- second.
