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
