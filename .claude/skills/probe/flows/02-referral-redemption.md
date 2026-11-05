# Flow 02 — Referral redemption (happy path + rejection paths)

**Feature**: `redeem-referral` edge function + `referral_events` table.
See CLAUDE.md's 2026-09-27 spot-check entry (first found this function's
source wasn't in the repo — BUG-04) and the `referral_events` cascade-
delete fix from the same date.

## Steps
1. Create two fresh throwaway accounts: referrer (A) and referee (B).
2. Have B sign up with `?ref=<A's real code>` in the URL (`index.html`
   captures it to `localStorage`; `chat.html` auto-fires `redeem-referral`
   on first load — this is by-design fast, not itself suspicious, per the
   2026-10-12 `warden` finding that corrected an earlier wrong assumption
   about redemption speed).
3. Confirm both A and B's `credit_ledger` show a real `+100,
   reason='referral_bonus'` row.
4. Attempt a second redemption with B's same code → confirm 409 (duplicate).
5. Attempt a self-referral (A redeeming A's own code) → confirm 400.
6. Attempt redemption with a garbage code → confirm 404.

## Expected outcome
Happy path credits +100/+100 exactly once; all three rejection paths
correctly blocked with zero ledger mutation.

## Known workaround
None flow-specific.

## History
First run: see this skill's build PR (2026-11-02).

**2026-11-05 sweep — PASSED (in-browser, production).** Referee session
injected, opened `https://aethyro.com/?ref=<referrer code>` (`localStorage.
aethyro_ref` = the code), then `chat.html`: `redeem-referral` auto-fired once →
200 `{success:true,credits_added:100}`, balance 200 → 300, the key cleared from
`localStorage`. Duplicate redemption → 409 `You have already redeemed a referral
code`; self-referral → 400 `Cannot redeem your own referral code`; garbage code →
404 `Invalid referral code`. `credit_ledger`: exactly one `+100 referral_bonus`
on each side, no row from any rejected attempt. (Call the rejection paths from
a page on the `aethyro.com` origin — the function's CORS allowlist rejects
`localhost`.)
