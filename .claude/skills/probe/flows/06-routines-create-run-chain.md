# Flow 06 — Routine create → manual run → run log → chain

**Feature**: scheduled routines (`user_routines`), `routine_run_log`
(2026-10-10), and routine chaining (`next_routine_id`, 2026-09-28).

## Steps
1. Signed-in throwaway account: create a routine with a simple, single-
   shot prompt (not a live-data task — `run-routines` has no tool access,
   per CLAUDE.md).
2. Click "Run now" → confirm it completes, bills `reason='routine'`,
   writes a `routine_run_log` row (`status: 'completed'`), and updates
   `last_result`/`next_run_at`.
3. Create a second routine, chain the first to it (`next_routine_id`),
   run the first again → confirm the second runs automatically afterward
   with the first's output passed as `chain_context` (the second's reply
   should reference the first's real output).
4. Attempt a self-chain and a true A→B→A cycle → confirm both rejected by
   the DB trigger, confirm a real non-cyclic chain still succeeds.
5. Force the account to 0 balance, run a routine with `email_on_result:
   true` → confirm a `routine_run_log` row with
   `status: 'skipped_no_credits'` and (if a real inbox is used) the skip-
   notification email.

## Expected outcome
All of the above match exactly — this flow has the most moving parts of
the seed corpus, so a partial pass (e.g. chaining works but the skip-email
doesn't) should be reported per-step, not collapsed into one pass/fail.

## Known workaround
The skip-notification email step needs a real inbox (AgentMail or
similar) to actually read delivered content — an `@example.com` throwaway
address will get a clean Resend rejection that looks like a failure but
isn't (CLAUDE.md documents this exact non-bug repeatedly). Either use a
real inbox for this one step or skip verifying delivery and just confirm
the `run-routines` call attempted the send.

## History
First run: see this skill's build PR (2026-11-02).

**2026-11-05 sweep — steps 1-5 PASSED (production, UI-driven), plus the
monthly-cap skip path (new in PR #211) and two bugs found.** Created "Probe B"
then "Probe A" chained to B via the form's "Then run" select; "Run now" on A →
`run-routines` 200 `ran:1`, A's reply `ALPHA`, B ran automatically with B's reply
"The previous step produced the word ALPHA" (chain context reached the model);
`credit_ledger` shows two `-1 reason='routine'` rows, `routine_run_log` two
`completed` rows, History shows "✓ Ran". Self-chain → `A routine cannot chain to
itself`; B→A cycle → `Chaining this routine here would create a cycle`; both
rejected with the real A→B link untouched. Forced balance 0 with `Email: on`:
"Run now" → `skipped_no_credits`, card shows "Last run skipped — out of credits"
(the notification email itself was not verified — `@example.com` recipient).
Restored balance and set `profiles.monthly_spend_cap_credits = 1`: "Run now" →
`skipped_monthly_cap`, card shows "Last run skipped — monthly spend cap reached",
`routine_run_log` row with that status (the status CHECK constraint now allows
it, migration `20261105150000`). **Bugs found:** (1) "Your routines" listed the
12 community templates owned by another user for an account with zero routines
(unfiltered `select('*')` + `routines_public_read`); "Run now" on one toasted
"Routine complete" while the server returned `{"ran":0}` — fix in draft PR
#216. (2) The "Run now" toast says "Routine complete" even when the run was
skipped (no credits / cap) — reported, not fixed (copy/UX call).
New pre-run text asserted: `#routineEstimate` ("~1–2 / 1–4 / 2–13 credits per run"
for haiku/sonnet/opus) and the "If a run fires with no credits, it is skipped…"
note; Tasks tab `#taskEstimate` ("~1–3 / 4–15 / 15–50 credits per step").

**2026-11-06 sweep — first pass against `run-routines` v5 (Tavily `web_search`
tool loop, PR #214), the `skipped_monthly_cap` status fix (PR #213) and PR #216
(production, UI-driven).** Created the real quick-start "Daily Briefing" via the
"Try it: daily AI briefing" button (haiku, `0 9 * * *`), then "Run now": `run-routines`
200 `ran:1 status:completed` in ~7 s, exactly one `credit_ledger` `routine` row
(-1, no duplicate), one `routine_run_log` `completed` row, `last_run_at`/`next_run_at`
set, UI shows the result and History "✓ Ran". A plain "Write a haiku about autumn"
routine and a chained Probe A -> Probe B (B's reply "The previous step produced the
word ALPHA") each completed; five runs = five `-1 routine` rows, five `completed`
log rows, balance 200 -> 195. A routine whose prompt demands live data ("top 3 Hacker
News stories right now") completed and returned real HN titles (one is on HN's front
page at the time of the check), so the Tavily tool path is live — but the snapshot
was not the live top 3, and the Daily Briefing's "top development from the last 24
hours" came back as the Oct-2025 Microsoft Agent Framework announcement (a real story,
~13 months stale): neither `run-routines` nor `chat` puts today's date in the system
prompt and the Tavily call has no recency filter, so "last 24 hours" is not
satisfiable (reported, not fixed). With `profiles.monthly_spend_cap_credits = 1`
(spend 5): "Run now" -> `ran:1 status:skipped_monthly_cap`, card badge "Last run
skipped — monthly spend cap reached (5 of 1 credits this month)", History row "Skipped
— monthly cap reached", zero new ledger rows (the silent CHECK failure PR #213 fixed
no longer occurs). **Bugs found, fixed in the draft PR that carries this entry:**
(1) clicking the quick-start button rendered the new routine as TWO identical cards
(one DB row): the tab click and `openDailyBriefingFlow()` both call `loadRoutines()`,
which awaits twice between clearing and appending the list, so overlapping calls both
append; (2) regression from PR #216: because the own-routines query is now filtered to
the caller, an account with zero routines (every new user) hits `loadRoutines()`'s
empty-state early `return` before `loadCommunityRoutines()` runs, so the Community
Gallery sits on "Loading…" forever (12 public templates exist; the gallery loads
once the account has one routine). **Still open, reported:** the "Run now" toast says
"Routine complete" even when the server returned `skipped_monthly_cap` /
`skipped_no_credits`; the balance pill does not update after "Run now" (read 200 two
seconds after a billed run; correct after reload).
**Sandbox tip**: the quick-start button inserts `email_on_result: true`; for an
`@example.com` throwaway intercept the POST with `ctx.route('**/rest/v1/user_routines*')`
and flip it to `false` so the "Run now" never attempts a (bouncing) email. To verify a
frontend fix before it is deployed, `ctx.route('https://aethyro.com/app/chat.html*', ...)`
with the patched file as the body — real origin, so CORS and the edge functions work.
