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
