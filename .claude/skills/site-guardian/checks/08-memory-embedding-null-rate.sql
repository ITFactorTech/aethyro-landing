-- Check 08: memory_embeddings rows silently missing their embedding.
--
-- First found by: the 2026-11-05 `probe` sweep (flow 07, Search tab showing
-- "No matches" after two chat sends ~2s apart). Confirmed from the live table:
-- 89% of that day's rows had `embedding IS NULL`, 25-67% on most days since
-- 2026-10-28.
--
-- The bug class: `embed-content`'s `embedTexts()` returns null on ANY Voyage
-- failure (rate limit, timeout, 5xx) with no retry and no log, and the caller
-- still INSERTs the row -- so a provider limit exceeded by a burst degrades
-- semantic memory/search quietly, with no error anywhere in the 24h log scan.
--
-- Run via execute_sql. One row per day, last 14 days.
select date_trunc('day', created_at)::date                                  as day,
       count(*)                                                             as total_rows,
       count(*) filter (where embedding is null)                            as null_embedding,
       round(100.0 * count(*) filter (where embedding is null) / count(*), 0) as pct_null
from public.memory_embeddings
where created_at > now() - interval '14 days'
group by 1
order by 1 desc;

-- CLEAN:    pct_null stays under ~10% on any day with >= 50 rows (a handful of
--           nulls from a genuine transient Voyage error is normal).
-- MISMATCH: any day with >= 50 rows above ~25% null, or a sustained run of days
--           above that. Do NOT conclude "Voyage is down" -- low-volume days are
--           usually 0%, which points at bursts vs. a per-minute limit, not an
--           outage. Reproduce with two chat sends ~2s apart (null rows) vs. one
--           after a 60-90s idle (embedded), per probe/flows/07.
--
-- Fix pattern (the 11-05 send-welcome-email v5 shape): log the provider status,
-- retry 429s with backoff / Retry-After, batch the user+assistant pair into one
-- request, and backfill the null rows. Escalate to `codex`; this is not a
-- sweep-sized fix.
