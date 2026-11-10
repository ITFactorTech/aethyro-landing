# Flow 04 — `model: "auto"` routing + the asymmetric safety nets

**Feature**: `chat`'s embedding-based auto-router (`classify_router_tier`
RPC, Phase 3, 2026-09-28) plus the credit-aware floor (2026-10-06) and the
image-attachment floor. See CLAUDE.md's "Database schema gotchas" entries
on `classify_router_tier` and the router-cap work.

## Steps
**Since 2026-11-08 run the tier-routing steps on a PAID account** — a no-purchase
account is forced to Haiku/Terra whatever is picked, so `auto` never resolves to
sonnet/opus for it (flow 11). Give the throwaway one synthetic `credit_ledger` row:
`reason='purchase'`, a unique fake `stripe_session_id` (e.g. `cs_test_<sweep>`),
`metadata {"credit_pack":"starter"}`, `delta 200` (the orchestrator-provisioned
account is otherwise no-purchase). While Anthropic is unfunded the paid account's
replies are served by OpenAI (`gpt-6.1-terra` for haiku, `gpt-6.1-sol` for sonnet/opus),
billed at the tier rate; the image-attachment case cannot be exercised then (below).
1. Signed-in throwaway account, `model: "auto"`, balance well above the
   100-credit floor:
   - Send a trivial acknowledgment ("thanks so much!") → confirm resolves
     to `haiku`.
   - Send a plain factual question → confirm resolves to `sonnet`.
   - Send a genuinely hard/novel security-audit-style prompt → confirm
     resolves to `opus`.
   - Attach an image with a trivial-sounding caption ("thanks!") → confirm
     it resolves to **`sonnet`**, never `haiku` (the attachment floor is
     "never below Sonnet": `chat/index.ts`'s `routeAutoModel()` comment and
     `classifyModelFromEmbedding()`'s `attachments.length > 0 && tier ===
     "light"` → `"medium"` bump). Opus only when the caption is long
     (>400 chars) or carries a heavy keyword. **This bullet previously said
     "`opus` regardless" — that was wrong against the code (corrected
     2026-11-05; the live run resolved `auto→sonnet`, matching the code).**
2. Same account, force balance below 100 credits (the `AUTO_MODEL_CREDIT_FLOOR`):
   repeat the hard-prompt case → confirm it now caps at `sonnet`, not
   `opus`.
3. With balance still below the floor, send the same hard prompt with an
   **explicit** `model: "opus"` pick → confirm the explicit choice is
   never overridden (the floor only ever affects `auto`).
4. Confirm the client's cost badge shows `auto→<resolved tier>` when auto
   picked a non-obvious tier.

## Expected outcome
All four classification cases resolve correctly; the credit floor caps
`auto` but never an explicit pick; the image floor always lifts a
light-looking caption to (at least) Sonnet.

## Known workaround
None flow-specific — classification is probabilistic by design (94.7%
leave-one-out accuracy per CLAUDE.md), so an occasional light/medium
boundary miss on a genuinely ambiguous short message is not itself a
regression; only a miss on one of the four clear-cut cases above is.

## History
First run: see this skill's build PR (2026-11-02).

**2026-11-05 sweep — PASSED (in-browser, production).** Balance 194, `auto`
(cost badge shows `auto→<tier>`): `"thanks so much!"` → `auto→haiku` (1 cr),
`"Explain how photosynthesis works in two sentences."` → `auto→sonnet` (1 cr),
a security-audit/root-cause prompt → `auto→opus` (6 cr), `"thanks!"` + a 64px
PNG → `auto→sonnet` (1 cr). Balance forced to 59 (< the 100 floor via an
`admin_adjustment` ledger row): the same audit prompt on `auto` → `auto→sonnet`
(capped), and on an **explicit** Opus pick → `opus` (5 cr, not overridden).
Corrected this file's image-attachment expectation (see step 1) — it had
claimed Opus, the code and the live run say Sonnet.
Tip: put "answer in one sentence" in the heavy prompt so a real Opus reply
stays at ~5-6 credits instead of 15-60.

**2026-11-09 sweep — steps 1-4 PASSED except the image case (BLOCKED while Anthropic is
unfunded); free-tier behaviour added.** Paid account (synthetic purchase row), balance 299,
`auto`: `"thanks so much!"` -> `auto→haiku` (1 cr), the photosynthesis question ->
`auto→sonnet` (1 cr), the OAuth security-audit prompt -> `auto→opus` (2 cr); ledger
`provider: openai`, `actual_model` terra / sol / sol, no `free_tier` flag. Balance forced
to 95 (< 100 floor via `admin_adjustment`): same audit prompt on `auto` -> `auto→sonnet`
(1 cr, capped), on an **explicit** Opus pick -> `opus` (2 cr, not overridden). Image
(paid, `auto`, `thanks!` + 64px PNG): the request reaches Anthropic only, the bubble shows
`Server error: 400 {"type":"error","error":{"type":"invalid_request_error","message":
"Your credit balance is too low to access the Anthropic API…"},"request_id":…}` (raw
provider error, no friendly mapping — already escalated), no ledger row. Free account
(no purchase): `auto` + the hard audit prompt -> `auto→haiku` (1 cr, Terra); image attach
-> client toast "Image attachments unlock with any credit pack (from $4). Free credits
cover text chat." with nothing sent, and a direct `chat` POST with an image attachment ->
`403 {"code":"free_tier_locked"}`.
