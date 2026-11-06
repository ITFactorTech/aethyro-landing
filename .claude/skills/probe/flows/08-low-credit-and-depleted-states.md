# Flow 08 — Low-credit warning, depleted state, and the monthly spend cap

**Feature**: the low-balance warning banner, the opus-cost-confirmation
modal (2026-10-09), the post-depletion contextual buy modal (2026-10-06),
and the monthly spend cap (2026-10-10).

## Steps
1. Signed-in throwaway account, force balance to ~25 credits → confirm the
   low-balance warning banner appears with a correct worst-case Opus-cost
   estimate.
2. New throwaway account, 0 real messages sent yet, force an explicit
   `model: "opus"` pick while balance is still above the low-balance
   threshold but the account is brand-new → confirm the one-time Opus
   cost-confirmation modal appears (not the low-balance banner — these are
   two different gates with different trigger conditions, don't confuse
   them), and confirm "Switch to Sonnet & send" / "Send with Opus anyway" /
   "Cancel" all behave correctly.
3. Force balance to 0 → send a message → confirm a 402 and the depleted
   contextual buy modal (not the generic one) appears, defaulting to
   highlighting the Starter pack.
4. Set a monthly spend cap below current spend → confirm the next send
   gets a distinct "Monthly cap reached" 402 (not "No credits"), and that
   the blocked attempt produced **zero** new `credit_ledger` rows.

## Expected outcome
All four gates fire under their own correct, distinct conditions with no
cross-contamination (e.g. the depleted modal never shows for a merely-low,
not-yet-zero balance) and a blocked attempt never partially bills.

## Known workaround
None flow-specific.

## History
First run: see this skill's build PR (2026-11-02).

**2026-11-05 sweep — all four gates PASSED (production, Playwright).**
(1) Balance 25: the low-balance banner shows for `opus`/`auto` ("Low balance
( 25 credits) — an Opus reply can cost up to ~80 credits and may not complete")
but not for `haiku` (threshold 10) or `sonnet` (threshold 15) — expected.
(2) Fresh account, 200 credits, 0 messages, explicit Opus: the one-time modal
fired (not the banner), "Cancel" kept the typed text, sent nothing and set the
flag; "Switch to Sonnet & send" flipped the model button and billed 1 cr
(`sonnet`); "Send with Opus anyway" billed 2 cr (`opus`) and a second Opus send in
the same browser did **not** re-show the modal. (3) Two tabs, last 2 credits
drained in tab 2 → its depleted bar showed, input disabled, depleted modal with
"You've used 2 credits across 2 messages this session — the Starter pack is the
smallest way to keep going right now." and Starter highlighted; tab 1 (still
thinking it had credit) sent → server 402 `{"error":"No credits","balance":0}` →
inline "You're out of credits. Buy credits" → depleted modal with its own
session-usage line, Starter highlighted. (4) Cap set to 1 with 175 spent: next
send → 402 `{"error":"Monthly cap reached","monthly_spend":175,"monthly_cap":1}`,
inline "You've hit your monthly spend cap (175/1 credits this month). Raise or
remove your cap →" linking `./dashboard.html#spendCapPanel`, no depleted
bar/modal, `credit_ledger` row count unchanged (14 → 14). Tip for forcing a real
402 on the pre-send gate: use a second tab/context to drain the balance after
the first page has loaded (a page loaded at balance 0 locks the input and never
sends).

**2026-11-06 sweep — all four gates PASSED again (production, Playwright), against
the code deployed after PRs #212-#216.** (1) Balance 25: low-balance banner visible
only for the Opus pick, hidden for Haiku/Sonnet. (2) 3 prior messages, 196 credits,
no flag: explicit Opus -> one-time modal ("196" shown, banner not shown); Cancel kept
the typed text, set the flag, sent nothing; in a fresh browser "Switch to Sonnet &
send" flipped the active model button to Sonnet and billed 1 credit. (3) Tab loaded
at 25, balance drained to 0 elsewhere, send -> `402 {"error":"No credits","balance":0}`,
inline "You're out of credits. Buy credits", depleted bar + disabled input, buy modal
with Starter highlighted; the session-usage line was empty because that tab had sent
zero messages (the contextual line is suppressed at 0 messages, as designed).
(4) Cap 1 with 200 spent: `402 {"error":"Monthly cap reached","monthly_spend":200,
"monthly_cap":1,"estimated_cost":2}`, inline cap message linking
`./dashboard.html#spendCapPanel`, no depleted bar/modal, ledger row count unchanged
(8 -> 8). Observation: `monthly_spend` counted the forced negative
`admin_adjustment` rows (-170, -25) as spend, i.e. it sums every negative delta, not
just usage.
