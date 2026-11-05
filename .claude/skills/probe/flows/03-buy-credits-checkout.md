# Flow 03 — Buy credits → real Stripe checkout URL (hard security constraint)

**Feature**: `buy-credits` edge function + `chat.html?buy=<pack>` entry
point. This flow directly checks CLAUDE.md's **hard security constraint**:
*"Never link a raw Stripe Payment Link... a bare `buy.stripe.com/...` link
proposed anywhere in this repo is a bug."*

## Steps
1. From a signed-in throwaway account, click every "Buy credits" entry
   point in `chat.html` (topbar, low-balance banner, depleted bar/inline,
   the agentic-task insufficient-credits link) for each of the 4 packs
   (`starter`/`value`/`power`/`pro_7k`).
2. For each, confirm the resulting URL is a real
   `https://checkout.stripe.com/...` session URL, **never** a bare
   `https://buy.stripe.com/...` link.
3. Grep the live-rendered page source for `buy.stripe.com` — zero matches.
4. Cross-check the pack's price/credits shown against
   `supabase/functions/_shared/packs.ts` and `/pack-config.js` (should
   already be CI-checked for drift by `.github/workflows/
   pack-config-check.yml`, but confirm visually too).

## Expected outcome
Every entry point resolves to a real `checkout.stripe.com` session with
the correct pack. Zero raw Stripe links anywhere in the rendered page.

## Known workaround
Don't actually complete a real Stripe checkout with a real card — confirm
the URL is correctly formed and reachable, that's sufficient; a full
successful-charge test is a separate, higher-stakes manual check (see
CLAUDE.md's auto-topup entries for why this project treats real-money
success paths as a distinct, deliberate verification step).

## History
**First run, 2026-11-02 — PASSED.** Live in-browser Playwright pass
against production, a real throwaway account, all 4 packs: every pack
button correctly navigated to a real `checkout.stripe.com` session URL.
Confirmed Aethyro's own rendered page (checked *before* navigating away,
not after — checking page content once already on Stripe's hosted
checkout page would false-positive-match benign Stripe-domain mentions
that have nothing to do with this constraint) contains zero
`buy.stripe.com` matches. Hard security constraint holds.

**2026-11-05 sweep — PASSED across every entry point (production,
Playwright).** Stubbed `checkout.stripe.com/**` with `page.route()` so the page
could "navigate" without loading Stripe, and read where `buy-credits`
(200) sent the browser: topbar "Buy more" → `starter`, low-balance banner link →
`value`, depleted bar link → `power`, the inline 402 "Buy credits" button →
`pro_7k`, and the Intelligence → Tasks "Insufficient credits… Buy credits →"
link → `value` — all five landed on `https://checkout.stripe.com/c/pay/cs_live_…`
(real sessions, never completed), zero `buy.stripe.com` in the rendered
`chat.html`. Modal prices/credits $4/200, $10/600, $30/2000, $90/7000 match
`pack-config.js`. **Found:** the Tasks "Buy credits →" link is rendered into
`#lowBalance`, which sits behind the open Intelligence panel's `#intelOverlay`,
so the first click only closes the panel (`elementFromPoint` at the link =
`intelOverlay`); the link works on the second click. UX paper-cut, reported not
fixed (a design call: close the panel first, or render the link inside it).
