# Check: 24h edge-function error-rate scan via `query_logs`

**First found by**: at least 4 prior sweeps (documented in CLAUDE.md's
recent-work-log across 2026-10-03 ×2, 2026-10-06, and 2026-10-09) tried a
direct table name — `function_edge_logs`, `edge_logs`, `function_logs` —
against `query_logs` and got `Table "function_edge_logs" does not exist`
(or an equivalent backend error) every single time, and each sweep gave up
and logged it as "a standing tooling limitation." It was never actually a
backend limitation — it was the wrong query shape, finally resolved by the
first-ever `site-guardian` orchestrator sweep, 2026-10-12.

**The actual fix**: there is one real unified table, `logs` — not a
per-source table. `source` is a filterable **column** on `logs`, whose
value is one of `function_edge_logs`, `edge_logs`, `function_logs`,
`auth_logs`, `postgres_logs`, `postgrest_logs`, `pgbouncer_logs`,
`realtime_logs`, `workflow_run_logs`, `storage_logs`, `supavisor_logs`,
`auth_audit_logs` (confirmed live via `select distinct source from logs`).
Filter on `source = 'function_edge_logs'`, don't try to query a table named
that.

**A second, separate gotcha inside the same query**: this backend is
ClickHouse, and `CAST(log_attributes['response.status_code'] AS
Nullable(Int64))` fails with `"Backend error! Retry your query."` — casting
this way is unreliable here. `toInt64OrZero(log_attributes['response.status_code'])`
works correctly for numeric comparison (e.g. `>= 400`). A plain string read
of `log_attributes['key']` needs no cast at all.

## Steps

```sql
select
  timestamp,
  log_attributes['response.status_code'] as status,
  log_attributes['request.method'] as method,
  log_attributes['request.pattern'] as pattern -- or whatever path field this
    -- deployment surfaces; check `select distinct log_attributes['response.status_code']...`
    -- once first if unsure of the exact attribute keys in use
from logs
where source = 'function_edge_logs'
  and timestamp > now() - interval 24 hour
  and toInt64OrZero(log_attributes['response.status_code']) >= 400
order by timestamp desc
limit 200;
```

## Clean result

Only expected-error-path codes (401s from an intentionally-unauthenticated
probe, 402s from a real no-credits gate, 429s from a real rate limit, etc.),
each a low, non-repeating count, with no dense cluster suggesting a real
outage or a silently-broken function.

## Mismatch

A real pattern: many 500s on one function, a spike in 401s on a function
that shouldn't need one, or any error code appearing far more than this
project's own real traffic volume would explain. Investigate via the
matching function's own logs/source before assuming it's noise.
