# Check: cron-dispatched `net.http_post` bursts vs. a provider's rate limit

**First found by**: the 2026-11-02 `site-guardian` sweep's serialized 24h
error-log scan (see check 06 for the query shape that surfaced it).

**The bug**: a `pg_cron` job whose `command` is a single SQL statement doing
`SELECT net.http_post(...) FROM <table> WHERE <eligibility condition>`
dispatches one async HTTP call **per matching row**, and `pg_net` fires them
near-simultaneously — not throttled, not serialized. If the target edge
function calls a third-party API with its own per-second rate limit (Resend,
and likely any other transactional-email/SMS provider used the same way),
a batch large enough to exceed that limit will have most of its calls fail
outright. Confirmed live: `drip-engagement`'s cron (`5 9 * * *`) fired ~85
`send-welcome-email` calls within a 10-second window, and 71 of them got a
real Resend `429 rate_limit_exceeded` (Resend's account-wide cap is 10
req/sec).

**Why this isn't always obvious from the symptom alone**: if the called
function only writes its "done" state (e.g. `email_drip_state.*_sent_at`)
on a successful send, a failure here isn't a permanent loss — it just
re-queues for the next day's run. That makes the bug look self-healing at
small scale, but it actually **compounds**: each day's batch is newly-
eligible rows *plus* every previous day's failures, so the backlog grows
as the user base grows, with no plateau. Check `email_drip_state` (or
whatever table a given cron's `WHERE` clause excludes on) for a real
backlog number before concluding this is harmless.

## Steps

1. Find any `cron.job` whose `command` text contains `net.http_post` inside
   a `SELECT ... FROM <table> WHERE ...` shape (as opposed to a single,
   one-row call):
   ```sql
   select jobname, schedule, command from cron.job where command ilike '%net.http_post%' and command ilike '%from%';
   ```
2. For each one, run the 24h/recent error-log scan (check 06) filtered to
   the target function's `function_id`, specifically looking for a dense
   cluster of identical-timestamp failures right at the job's own
   schedule time.
3. If found, check the target function's own logs (`source = 'function_logs'`)
   around that exact window for the real provider error — a `429` with a
   named rate limit is the tell; don't assume it's the already-documented
   `@example.com`-test-address-rejection non-bug (that's a clean `4xx`
   validation error, not a `429`).
4. Quantify the real backlog: query the table the cron's `WHERE` clause
   reads, counting rows still matching the "not yet sent" condition.

## Clean result

No dense same-timestamp cluster of a real provider rate-limit error at any
cron job's schedule time, and no real cron-fed "not yet sent" backlog
beyond what a quiet day's worth of newly-eligible rows would explain.

## Mismatch / fix pattern

A real cluster of `429`s (or an equivalent provider-side rate-limit
response) at a cron's exact fire time, with a real growing backlog in the
table it reads. Fix at the called edge function's own HTTP-call site (not
the cron dispatch) with a bounded retry+backoff on that specific error code
— honor a `Retry-After` header if the provider sends one, otherwise
exponential backoff capped at a few seconds, bounded to a handful of
attempts so a real outage still fails closed rather than hanging. This
keeps each invocation resilient to the burst without redesigning how the
cron queues work, and is provider-agnostic — the same pattern applies to
any transactional email/SMS/webhook call made this way.
