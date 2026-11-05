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

**Second run, 2026-11-02, closing the exact gap the first run flagged —
found and fixed a real bug.** A real in-browser Playwright pass (session
injected into `localStorage`, per the Sandbox/Playwright playbook)
sending a message immediately after `#balancePill` became visible
consistently lost the assistant's reply from the DOM — exactly 1
`.msg-row` instead of 2, despite the message billing and saving correctly
server-side the whole time. Root-caused as a real race: `init()` reads
the URL's `?c=` param *after* several sequential `await`ed setup calls;
if the user sends fast enough, `send()`'s own
`ensureConversation()`/`setActiveConv()` pushes the brand-new
conversation's id into the URL first, and `init()` then treats that as a
page-load deep link and reloads the conversation from the DB — wiping the
live bubble. Confirmed via a control run (waiting ~4s before sending
never lost the reply) and fixed by capturing `urlConvId` as `init()`'s
very first statement, before any `await` (PR #202). Re-verified the fix
against a real deployed branch preview URL (needed for a genuine
CORS-allowlisted origin — `localhost` isn't on `chat`'s CORS allowlist, so
a `localhost`-served copy can only prove the DOM no longer gets wiped, not
a full success path): immediate-send now correctly shows 2 rows, a real
rendered cost badge (`"1 credit· 1,055 in / 5 out tokens · haikuReceipt"`),
and the balance pill updating correctly. This flow's own expected
outcome now holds end-to-end, not just at the API level.

**2026-11-05 sweep — PASSED (in-browser, production; account provisioned by
the sweep orchestrator, not created via the UI — a brand-new-signup-through-
the-UI step was therefore not exercised).** Checked the pre-provisioned
account's rows: exactly one `profiles`, one `referral_codes`, one
`signup_bonus` (+200). Session injected into `localStorage`, `chat.html`
driven: explicit Haiku / Sonnet / Opus sends each rendered a real reply and a
cost badge (`1 credit · 1,025 in / 8 out tokens · haiku`, `1 credit · … ·
sonnet`, `2 credits · … · opus`), the balance pill went 200 → 199 → 198 → 196,
and `credit_ledger` matched row-for-row (`-1/-1/-2`, `metadata.provider:
anthropic`, `metadata.model` = tier) with a signed receipt on each (5
`generation_receipts` for 5 sends). Also verified the new homepage → chat
carry-over (see flow 09) and the composer's pre-send estimate ("up to ~N
credits": 2 / 13 / 62 / 62 (auto) / 13 (gpt) for a 59-char message on
haiku / sonnet / opus / auto / gpt — matches `estimateWorstCaseCost()`; empty
input clears it).
