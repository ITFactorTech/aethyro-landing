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
   - Attach an image with a trivial-sounding caption → confirm resolves to
     `opus` regardless (the attachment floor overrides classification).
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
`auto` but never an explicit pick; the image floor always wins over a
light-looking caption.

## Known workaround
None flow-specific — classification is probabilistic by design (94.7%
leave-one-out accuracy per CLAUDE.md), so an occasional light/medium
boundary miss on a genuinely ambiguous short message is not itself a
regression; only a miss on one of the four clear-cut cases above is.

## History
First run: see this skill's build PR (2026-11-02).
