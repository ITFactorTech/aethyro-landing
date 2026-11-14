# Site Guardian checks corpus

Each file here is a **concrete, runnable** check — a real query or tool-call
sequence, not a prose description of one. The point is that a future sweep
can execute the file directly instead of re-deriving the forensic method
from scratch, the way every entry here originally had to be found by hand.

This corpus is meant to **grow**. Per `site-guardian/SKILL.md`'s own
instructions: every time a sweep confirms a genuinely new bug class (not a
recurrence of one already covered here), add a new numbered file in this
same format. Don't backfill this exhaustively from history in one pass —
it's seeded with the highest-value, most-recurring patterns from this
project's incident history; the rest grows incrementally, for real, as new
classes are actually found.

## Format

Every file: a one-line header naming the real incident it comes from, the
exact query/tool-call sequence to run, what a clean result looks like, and
what a mismatch looks like. `.sql` files are literally runnable via
`execute_sql`. `.md` files are runbooks for checks that span multiple tool
calls (comparing two different tools' output) rather than a single query.

## Current checks

| File | Catches | First found by |
|---|---|---|
| `01-table-grant-floor.sql` | A new table's default-privilege grant to `anon`/`authenticated` exceeding its intended RLS-scoped access | `api_keys` leaking `key_hash`, 2026-09-28 |
| `02-function-privilege-matrix.sql` | A `SECURITY DEFINER` function's `EXECUTE` grant not matching intent per-role | `classify_router_tier` callable by any signed-in user, 2026-09-29 |
| `03-credit-ledger-reason-literals.sql` | A `credit_ledger.reason` value used in source but missing from the live CHECK constraint | `run-routines`/`run-agent-task` silently failing every billing insert, 2026-09-28 |
| `04-migration-reconciliation.md` | Local `supabase/migrations/` drifting from the real tracked `schema_migrations` version history | The month-long migration-history drift, reconciled 2026-10-09 |
| `05-edge-function-byte-diff-and-verify-jwt.md` | Committed edge-function source silently stale vs. what's actually deployed, or `verify_jwt` drifting from `supabase/config.toml` | The PR #97 auto-model-routing regression, 2026-09-28 |
| `06-edge-function-error-log-query.md` | The correct `query_logs` shape for a 24h edge-function error scan (unified `logs` table, `source` as a column value, `toInt64OrZero` for numeric comparison) | Resolved a "standing tooling limitation" that had failed identically across 4+ prior sweeps, 2026-10-12 |
| `07-cron-dispatched-email-burst-rate-limit.md` | A `pg_cron` job fanning out one `net.http_post` per row into a provider's per-second rate limit, silently losing most of a batch | `drip-engagement`'s 09:05 burst losing ~71 of ~85 sends to Resend 429s, 2026-11-02 |
| `08-memory-embedding-null-rate.sql` | `memory_embeddings` rows inserted without their embedding because the Voyage call failed silently under a burst | `probe`'s flow 07 finding: 89% null on 2026-11-05 |
| `09-rpc-error-discard-grep.md` | Billing/cap RPC call sites that discard `error` and default to a value that lets the request proceed | The `get_credit_balance` fail-open (2026-10-03) whose call-site half was never closed; re-found 2026-11-05 |
| `10-rls-policy-without-role-grant.sql` | An RLS policy naming `anon`/`authenticated` for a command the role holds no table/column GRANT for, so the policy (and the feature built on it) never works | Shared-conversation links broken for every non-owner for ~1 month, 2026-11-09 |
| `11-csp-vs-app-dependencies.md` (+ `11-csp-scan/`) | The enforced `_headers` CSP being stricter than what the pages load, silently breaking highlight.js CSS, pdf.js, Pyodide, marked/DOMPurify on `share.html` and a GA4 beacon | Gate 0 hosting-parity work, 2026-11-12 |
| `12-breaker-counts-caller-errors.md` | A provider circuit breaker counting errors that are not the provider's (a closed client stream), so three abandoned requests open a step's breaker for every account | `openai:terra` breaker opened by aborted streams, 2026-11-14 |
| `13-farm-accounts.sql` | Which accounts are farm / bot accounts, by explicit rules (confirmed domains, Gmail duplicates, suspect domains), with balances and safety flags | The 2026-11-14 farm-cleanup planning, after six months of re-deriving it by hand |
| `14-new-signup-cluster-detector.sql` | A NEW farming wave in the sweep window: same-domain bursts, Gmail mailbox repeats, same-minute signups, self-labelled `autoreg`, API keys with no chat | The farms keep changing domain (fldubai, maxxspace, kuromee ...), so a blocklist is always one wave behind |
