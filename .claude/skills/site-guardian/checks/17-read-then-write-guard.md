# Check: a cooldown or once-only guard that reads, decides in code, then writes

**First found by**: `auto-topup-charge` and `run-routines`' scheduled runs
(2026-11-06), then `webhook-routine-trigger` (2026-11-16: a 30-second cooldown
that every one of N simultaneous requests passed, so a routine ran and was
billed N times).

**Why review keeps missing it**: the code reads correctly top to bottom, and a
test that sends two requests *one after the other* passes, because the second
request does see the first one's write. Only requests that overlap expose it:
they all read the old value before any of them writes. The exploit roster's
"webhook replay" attempt was sequential, so it reported this guard as working
on every sweep from 2026-10-22 on.

**The rule**: the guard is the WRITE, not the read. One conditional `UPDATE`
whose `WHERE` repeats the condition, with `RETURNING` / `.select("id")`, and the
action happens only if a row came back. Postgres makes the losers wait on the
row lock and re-evaluate their `WHERE` against the committed row, so exactly one
caller wins. A claim error must stop the action (fail closed).

```ts
const { data: claimed, error } = await supaAdmin.from("t")
  .update({ last_at: now })
  .eq("id", id)
  .or(`last_at.is.null,last_at.lte.${cutoffIso}`)   // the condition, re-checked in the database
  .select("id");
if (error) return fail503();          // no claim -> no action
if (!claimed?.length) return skip();  // somebody else won
```

**The check (static, from the repo root):**

```bash
grep -rnE "COOLDOWN|_warned_at|last_attempt_at|last_triggered_at|next_run_at" supabase/functions --include=index.ts | grep -v "/_tests/"
```

For every guard the grep finds, read the write that follows the comparison and
answer two questions: does the `UPDATE` carry the condition in its own filter
and hand back a row, and does the action wait for that row?

2026-11-16 baseline:

| Site | Guard | State |
|---|---|---|
| `auto-topup-charge` (1 h between charge attempts) | conditional `UPDATE … or(is.null, lt.cutoff)` + row check | atomic since 2026-11-06 |
| `run-routines` scheduled run (one run per slot) | compare-and-swap on `next_run_at` | atomic since 2026-11-06 |
| `webhook-routine-trigger` (30 s between triggers) | conditional `UPDATE … or(is.null, lte.cutoff)` + row check | atomic since v2, 2026-11-16 |
| `chat` low-credit / depleted email stamps (24 h) and `send-low-credit-email` (7 days) | read, send, then unconditional stamp | **not atomic, accepted**: the worst case is a second copy of one warning email when two replies finish together; no money moves |

A guard that only limits an email may stay read-then-write. A guard in front of
a charge, a billed run or a credit grant may not.

**Tests that prove it** (run both when one of these functions changes):

```bash
cd supabase/functions/_tests/node && node --experimental-strip-types --no-warnings --import ./register.mjs \
  webhook-routine-trigger.test.mjs ../../webhook-routine-trigger/index.ts     # 10 simultaneous hits -> one run
supabase/tests/webhook-cooldown-claim.sh 20                                     # real Postgres 16, 20 sessions -> one run
```

The second script also runs the old read-then-write shape and expects every
session to get through, so it fails if the test ever stops being able to see
the bug.

**CLEAN**: every money-path guard in the table is a conditional write whose
returned row gates the action. **MISMATCH**: a new guard, or a rewrite of one
of these, that compares in code and then writes without the condition. Treat a
mismatch on a money path as a real finding: fix it in a PR with a simultaneous-
request test, do not just note it.

**Live re-check** (exploit roster item 15): on a throwaway account's routine
and webhook, send 5 requests at the same instant; exactly one `200`, four
`429`, and exactly one new `reason = 'routine'` ledger row.
