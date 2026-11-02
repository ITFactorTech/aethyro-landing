# Flow 01 — Signup → signup bonus → first chat send, all three tiers

**Feature**: core onboarding + billed chat. See CLAUDE.md's "Database
schema gotchas" (the `handle_new_user()`/`grant_signup_bonus()` trigger
history, the double-signup-bonus bug fixed 2026-09-27) and the `MODEL_MAP`/
`CREDIT_RATES` billing path in `supabase/functions/chat/index.ts`.

## Steps
1. Create a fresh throwaway account via the established `test-admin-setup`
   redeploy pattern (`auth.admin.createUser({email_confirm:true})` —
   bypasses the real email-confirmation flow, since driving a real inbox
   isn't necessary for this check).
2. Confirm exactly one `profiles` row, one `referral_codes` row, and one
   `credit_ledger` row with `reason = 'signup_bonus'` (delta +200) — not
   two of any of them.
3. Sign in (inject the real session into `localStorage` per the Sandbox/
   Playwright playbook if the OAuth/password UI hits the proxy's TLS
   artifact) and drive `app/chat.html`.
4. Send one message on each of `model: "haiku"`, `"sonnet"`, `"opus"`
   explicitly. For each: confirm a real assistant reply renders, the
   per-message cost badge shows a plausible credit cost and token counts,
   and a matching `credit_ledger` row (`reason = 'chat_usage'`) with
   `metadata.model` matching the tier exists.
5. Confirm the balance pill decremented correctly after each send.

## Expected outcome
Exactly one signup bonus, three successful replies billed at their
respective tiers, balance reflects all four debits/credits correctly.

## Known workaround
None flow-specific beyond the general Sandbox/Playwright playbook.

## History
**First run, 2026-11-02 (this skill's own build PR) — PASSED, API-level
proof, not yet a full in-browser Playwright click-through.** A real
throwaway account (`test-admin-setup`, restubbed to 410 after, confirmed
via live curl) showed exactly one `signup_bonus` row (+200), then real
`chat` calls on `model: "haiku"`/`"sonnet"`/`"opus"` each succeeded and
billed correctly (`-1`/`-1`/`-2`, `metadata.provider: "anthropic"`,
`metadata.model` matching the requested tier) with a real signed
generation receipt on each — confirmed via direct `credit_ledger` SQL
after each send, not just the HTTP response. Confirms the same
exact-one-bonus invariant CLAUDE.md's 2026-09-27 fix established still
holds, and that `chat`'s billing-by-tier logic is unchanged. **What this
run does NOT establish**: it drove `chat` directly via its real request
shape (`{model, message, history}`), not through `app/chat.html`'s UI in
an actual browser — the cost badge rendering, balance-pill update, and
receipt-modal click-through (the UI-layer half of this flow) still need a
real Playwright pass. Zero orphaned rows confirmed after cleanup.
