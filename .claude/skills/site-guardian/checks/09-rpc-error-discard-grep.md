# Check: RPC call sites that destructure only `{ data }` and discard `error`

**First found by**: the 2026-10-03 `get_credit_balance` incident (the function
raised `Forbidden` for its own service-role caller and every billed surface
silently fail-opened because each caller threw the error away), and re-found
by the 2026-11-05 `backend-reviewer` sweep, which showed the *call-site* half
of that incident was never closed: the function was fixed, the pattern that hid
it was not.

**Why a function-level review keeps missing it**: a `SECURITY DEFINER` function
can be perfectly correct and its callers still turn any future RPC error into a
silent default. Whether that default is fail-open or fail-closed depends on one
expression at each call site, which a migration review never sees.

**The check (static, run from the repo root):**

```bash
grep -rnE 'const \{ data[^,}]*\} = await [A-Za-z]+\.rpc\(' supabase/functions --include=index.ts
```

2026-11-05 baseline: 15 sites. Triage each by what it does when `data` is null:

| Site | When the RPC errors |
|---|---|
| `chat/index.ts` pre-send balance gate (`typeof balance === "number" && balance <= 0`) | **FAILS OPEN** -- the gate doesn't fire. This is the 2026-10-03 mechanism. |
| `api-chat` / `run-agent-task` / `run-routines` balance gates (`typeof x === "number" ? x : 0`) | fail closed (null -> 0 -> blocked) |
| every `get_monthly_spend` site (6) | `spent = 0` -> the cap stops enforcing (fail-open, lower stakes) |
| `match_memory_embeddings` / `match_document_chunks` (retrieval) | degrade to "no hits" -- acceptable |

**CLEAN**: every billing-gate or cap read either checks `error` or has a
non-number default that blocks. A *new* site appearing in the grep output that
guards billing is the thing to look at.

**MISMATCH**: any billing/cap read where `null` lets the request proceed.
Don't fix it inside a sweep unless you can verify the failure path live (which
needs an injected RPC failure) -- write it up in Pending with the file:line and
a proposed `if (error) return 503` fail-closed patch, per the escalate rule.

**Not covered here**: `.from(...).insert/update` calls whose `error` is dropped
(a different shape; `credit_ledger` inserts already log theirs).
