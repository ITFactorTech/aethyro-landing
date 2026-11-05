# Flow 09 — Homepage try-box → signup CTA → question carried into chat (prefill only)

**Feature**: the homepage inline try-box (`index.html`: `#tryForm`, 3
`.try-chip` starter chips, real anonymous `trial-chat`), the
`localStorage.aethyro_pending_prompt` hand-off, and `chat.html`'s carry-over
block (prefills `#input` after ~800 ms, **never auto-sends**, skips the intro
tour via `window.aethyroCarriedPrompt`). Shipped in PRs #207-#211.

## Steps
1. Logged-out production `https://aethyro.com/`: assert the H1 (currently
   "Claude Opus 5.5. Without the $20/month."), that `#tryChips` holds exactly
   3 chips ("Rewrite an email" / "Explain something simply" / "Write some
   code") each with a `data-prompt`, and that `#tryInput` exists.
2. Click one chip → a real `trial-chat` request (200) streams a reply into
   `#tryOutput`; afterwards `#tryCtaLink` ("Like that? Sign up free for 200
   credits →") appears with `href="/app/signup.html"` and
   `localStorage.aethyro_pending_prompt` equals the chip's prompt (it is set
   when the CTA is shown, i.e. after every reply **or** a 429 — both paths call
   `showCta()`). This spends one of the sandbox IP's 3 free anonymous
   messages/day — use one chip, not all three.
3. Click the CTA → lands on `/app/signup.html`; the key survives the
   navigation.
4. Signed-in throwaway account (session injected), key pre-seeded on an
   `aethyro.com` page, open `app/chat.html`: after `#balancePill` is visible and
   ~2.5 s, `#input` equals the stored prompt, **zero** `.msg-row`s exist, the
   balance is unchanged, the key is removed, the onboarding tour
   (`#onboardBackdrop.show`) is **not** shown — and a control run with no
   pending prompt and no `aethyro_onboarded_v1` flag **does** show it.

## Expected outcome
Prompt carried, prefilled, not sent, tour skipped only when carried; the
try-box CTA always goes to `/app/signup.html`.

## Known workaround
`trial-chat` is IP-rate-limited (3/day) — a 429 still exercises the CTA +
persistence path. Seed `aethyro_pending_prompt` on any `aethyro.com` page
before navigating to `chat.html` (localStorage is per-origin).

## History
**2026-11-05 sweep — PASSED.** H1 "Claude Opus 5.5. Without the $20/month.";
3 chips as above; chip #2 → `trial-chat` 200, real reply ("**Traditional IRA:**
You get a tax break now…"), CTA text "Like that? Sign up free for 200 credits →"
→ `/app/signup.html`, `aethyro_pending_prompt` = the chip prompt and still set
after landing on signup. Signed in: `#input` prefilled with exactly that prompt,
0 message rows, balance 200 → 200, key cleared; tour skipped (0
`#onboardBackdrop.show`), control (no pending prompt) showed it (1). Note: an
earlier selector (`#onboardModal`) matched nothing — assert on
`#onboardBackdrop.show`.
