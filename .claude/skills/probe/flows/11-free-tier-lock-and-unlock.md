# Flow 11 — Free tier (no purchase): Haiku/Terra only, locked picks, upsell, image 403, unlock after a purchase row

**Feature**: PR #236 (2026-11-08). An account with no `credit_ledger` row of
`reason='purchase'` (own or team) is forced to `modelKey="haiku"` and
`forceProvider="openai"` in `chat` (served by `gpt-6.1-terra`, billed at the Haiku
rate, never reaches Anthropic); explicit Sonnet/Opus/GPT picks are served the same way
and reported as `cost.lockedTier`; image attachments are `403 free_tier_locked`;
`run-routines`/`run-agent-task` clamp to Haiku on OpenAI. Client side (`chat.html`,
`applyFreeTier()`/`detectFreeTier()`, PR #238): `#modelBar.free-tier`, `tier-locked`
class on the Sonnet/Opus/GPT buttons, an OpenAI-specific cloud note, a toast on picking a
locked tier, the "Unlock … with any pack →" upsell under the reply (opens the buy modal,
surface `tier_locked`), cost estimate/low-balance banner at the Haiku rate, no Opus-cost
modal. The free grant is 100 credits.

## Steps
1. Orchestrator-provisioned throwaway with no purchase row (balance 100). Open
   `app/chat.html`: `#modelBar` has class `free-tier`; the buttons report
   `auto:open, haiku:open, sonnet:locked, opus:locked, gpt:locked`; `#cloudNote` says free
   credits run on OpenAI GPT-6.1 Terra and messages go to OpenAI, not Anthropic.
2. Pick Sonnet (toast "Free credits run on the fast Haiku-rate model. Any credit pack (from
   $4) unlocks Sonnet."), send a message: reply renders, badge `1 credit … · haiku`, the
   "Free credits use the fast model. Unlock Sonnet with any pack →" button appears and opens
   `#creditModal`; response `cost` = `{requestedModel:"sonnet", lockedTier:"sonnet",
   freeTier:true, provider:"openai", actualModel:"gpt-6.1-terra"}` (read the chat response
   tail, or `credit_ledger.metadata`: `free_tier:true`, `provider:"openai"`). Repeat for
   Opus — and confirm **no** Opus-cost confirmation modal appears. Composer estimate for an
   Opus pick reads "up to ~2 credits" (Haiku rate), the low-balance banner never uses the
   Opus 80-credit threshold.
3. `model: "auto"` with a hard prompt -> `auto→haiku` (never sonnet/opus).
4. Attach an image: client toast "Image attachments unlock with any credit pack (from $4).
   Free credits cover text chat." and nothing is sent; a direct `chat` POST with an image
   attachment returns `403 {"code":"free_tier_locked"}`.
5. Insert ONE synthetic purchase row (`reason='purchase'`, unique fake
   `stripe_session_id`, `metadata {"credit_pack":"starter"}`, `delta 200`) and reload:
   `#modelBar` has no `free-tier` class, no locked buttons, the Opus modal can fire (flow
   08), and Sonnet/Opus sends are billed at their own tier (1 / 2 credits) with
   `freeTier:false` (served by `gpt-6.1-sol` while Anthropic is unfunded).
6. Routines on a free account: "Run now" bills `routine` -1 with
   `metadata.provider:"openai"`, `metadata.model:"gpt-6.1-terra"` whatever model the routine
   names (flow 06).

## Expected outcome
Free accounts are only ever served Haiku-rate OpenAI Terra, with honest UI (locks, upsell,
cloud note), no image path, no Opus modal; one purchase row switches every one of those
off. Nothing here touches Anthropic.

## Known workaround
Anthropic being unfunded makes the paid-account half indistinguishable by provider (both
are OpenAI); distinguish by `actualModel` (terra vs sol) and by the billed tier. Do not
complete a real checkout to test step 5 — the synthetic ledger row is the unlock.
`run-agent-task` on a free account and the 503-on-lookup-failure path were NOT exercised.

## History
**2026-11-09 sweep — steps 1-5 PASSED (production, in-browser; free accounts
orchestrator-provisioned, paid account = synthetic purchase row).** See the 2026-11-09 entries
of flows 01 (free sends, lock/upsell/ledger evidence), 04 (free `auto` -> `auto→haiku`,
image toast + direct `403 free_tier_locked`, paid auto-routing + 95-credit floor) and 08
(no Opus modal for free, modal for paid). Paid account `#modelBar` class was plain
`model-bar` (no `free-tier`); its Sonnet send billed 1 cr and Opus 2 cr via `gpt-6.1-sol`,
ledger without `free_tier`. Step 6 passed in flow 06 (three routine rows, provider openai,
model `gpt-6.1-terra`).
