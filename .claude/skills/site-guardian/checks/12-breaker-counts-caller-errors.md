# Check: a circuit breaker that counts errors which are not the provider's

**First found by**: the 2026-11-14 sweep. `probe` was driving free-tier chat when
`openai:terra`'s breaker opened (3 failures, 2 minutes) with no OpenAI outage.
The production edge logs showed three `The stream controller cannot close or
enqueue` errors at 16:01:01, 16:01:32 and 16:02:04Z -- the *client* had gone
away mid-stream, Deno's response-stream controller threw on the next enqueue,
and that throw travelled up through the provider call and was recorded by
`runChain` / `completeWithFailover` as a failure of the provider step.
Fixed in #256 (`isClientDisconnect()` in `_shared/failover.ts`).

**Why review keeps missing it**: the breaker logic is correct for provider
errors. The defect is what else can reach the same `catch`. Any error thrown
*while the provider call is on the stack* lands in it -- including errors from
the caller's own side (a closed response stream, an aborted request, a
serialization bug in the `onTextDelta` callback). Reading `recordFailure()`
shows nothing wrong; you have to read what the `catch` wraps.

It is also exploitable by anyone with an account: start three streaming
requests and abort each, and every free account is served by the fallback
model for the breaker window.

**The check, static (repo root):**

```bash
grep -rn "recordFailure(" supabase/functions --include=*.ts
```

For each hit, read the `try` it belongs to and answer: can the *caller's*
callbacks (stream `enqueue`/`close`, `onTextDelta`, tool executors) throw inside
that `try`? If yes, the `catch` must separate that error from a provider error
before calling `recordFailure`. Baseline 2026-11-14 (after #256): the two
streaming sites in `_shared/llm.ts` and `runChain` guard with
`isClientDisconnect`; the empty-reply site and the two `runWithOpenAIFailover`
sites are intentionally unguarded (empty reply is a provider outcome; the
background jobs do not stream to a client).

**The check, live (needs one throwaway free account; password grant for a JWT):**

1. Read `provider_health` (expect `openai:terra` at 0 failures).
2. Start 4-5 `chat` requests with a long-answer prompt and abort each with the
   client (`curl --max-time 2.5` works).
3. Read `provider_health` again, and read the function logs
   (`source = 'function_logs'`) for `client went away during ... not counted`.

**CLEAN**: `consecutive_failures` for `openai:terra` / `openai:luna` unchanged, no
`opened_until`, one `client went away` log line per aborted request, no
`credit_ledger` row for the aborted requests, and a normal message afterwards
still answered by `gpt-6.1-terra`.

**MISMATCH**: any step's failure counter moves, or a breaker opens, because of
aborted requests. Fix by extending `isClientDisconnect()` for the new error
shape, never by raising the failure threshold.

**Offline test**: `12-breaker-test/disconnect.test.mjs` runs the chain engine against a
stub `provider_health` (Node 22: `node --experimental-strip-types
12-breaker-test/disconnect.test.mjs supabase/functions/_shared/failover.ts`). On
unmodified pre-#256 code its four disconnect tests fail; with the fix all eight pass.
`_shared/llm.ts` cannot run outside Deno (esm.sh imports), so its two catch sites
are covered by the live check above and by reading.

**Notes**: aborts that happen before any bytes reach the client (a request that
takes longer than the abort timer to produce its first byte) exercise the
"before output" branch; aborting later exercises the "after output" branch.
