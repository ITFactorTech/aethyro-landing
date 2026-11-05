# Flow 10 — Public surfaces: OAuth-first signup, no-subscription page, CTA sweep, pricing numbers

**Feature**: `/app/signup.html` leading with "Sign up with Google" /
"Sign up with GitHub" (`#googleBtn`, `#githubBtn` → `supabase.auth.
signInWithOAuth`), the SEO page `/claude-without-subscription.html`, the
"every primary Start-free CTA lands on `/app/signup.html`" rule, and the
pack-pricing display (`pack-config.js` ↔ homepage cards). Shipped in PRs
#207-#211. Pure logged-out checks — needs no account and bills nothing.

## Steps
1. `https://aethyro.com/app/signup.html`: both OAuth buttons are visible and sit
   **above** the email form (button `y` < form `y`). Intercept
   `**/auth/v1/authorize**` with `page.route()` (fulfil a stub — **never**
   complete a provider login) and click each: the captured URL must be
   `https://uzmdqbtflcpikjdrggqc.supabase.co/auth/v1/authorize?provider=google|
   github&redirect_to=…`.
2. `/claude-without-subscription.html`: 200, title "Use Claude Without a
   Subscription — Pay Per Use | Aethyro", every `application/ld+json` block
   `JSON.parse`s (one `FAQPage`, 5 questions), every internal link returns 200
   (including `/#calculator` — confirm `id="calculator"` exists on the homepage),
   and the primary CTA click lands on `/app/signup.html`.
3. CTA sweep over `/`, `/pricing.html`, `/claude-without-subscription.html`,
   `/claude-opus-alternative.html`, `/use-cases.html`,
   `/ai-chat-for-developers.html`, `/developers.html`, `/routines.html`,
   `/trust.html`: every link whose text starts "Start free / Get started / Try
   free / Create … account" must have a path of `/app/signup.html` (query
   strings such as `?next=chat` / `?next=buy&pack=…` are fine). Click-test the
   hero CTA and the nav CTA on `/`. (The sticky bar CTA is only on-screen after
   scrolling — check its `href`, don't click it blind.)
4. Pack numbers: homepage "¢ per credit" lines must equal price/credits from
   `window.AETHYRO_PACKS` ($4/200 = 2.0¢, $10/600 = 1.67¢, $30/2000 = 1.5¢,
   $90/7000 = 1.29¢); `pricing.html` pack cards show $4/200, $10/600, $30/2,000,
   $90/7,000 credits. Note: the per-credit lines are on **`index.html`'s
   `#pricing`**, not `pricing.html`.
5. 390 px viewport: no horizontal overflow on `/`, `/app/signup.html`,
   `/claude-without-subscription.html`, `/pricing.html`.

## Expected outcome
All checks hold; nothing in this flow touches billing or auth state.

## Known workaround
Block fonts/GA/Cloudflare-insights requests (playbook) — their `ERR_FAILED`s are
expected noise.

## History
**2026-11-05 sweep — PASSED.** Google button y=266, GitHub y=321, email form
y=427; stubbed authorize hits: `…/auth/v1/authorize?provider=google&redirect_to=…`
and `…provider=github…`. No-subscription page: 200, FAQPage JSON-LD valid (5 Qs),
all 8 internal links 200, CTA → signup. CTA sweep: 15/6/3/3/3/3/2/1/2 CTAs on
the 9 pages, **0** not pointing at `/app/signup.html`; hero + nav clicks landed on
`/app/signup.html`. Homepage per-credit lines 2.0¢ / 1.67¢ / 1.5¢ / 1.29¢ match
`pack-config.js`; `pricing.html` has no per-credit lines (cards only). 390 px:
`scrollWidth == clientWidth == 390` on all four pages. Observed (copy, not
fixed — `oracle`/brand call): older pages (`claude-opus-alternative`, `use-cases`,
`ai-chat-for-developers`, `terms`, `blog/*`, `app/share`) still say "Opus 5"
while the homepage/pricing/chat/new pages say "Opus 5.5".
