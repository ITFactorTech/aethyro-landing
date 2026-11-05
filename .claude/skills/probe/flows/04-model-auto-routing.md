# Flow 04 — `model: "auto"` routing + the asymmetric safety nets

**Feature**: `chat`'s embedding-based auto-router (`classify_router_tier`
RPC, Phase 3, 2026-09-28) plus the credit-aware floor (2026-10-06) and the
image-attachment floor. See CLAUDE.md's "Database schema gotchas" entries
on `classify_router_tier` and the router-cap work.

## Steps
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
