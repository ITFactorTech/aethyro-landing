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
