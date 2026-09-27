# Aethyro — Project Memory

This file is read automatically at the start of every Claude Code session in
this repo. Keep it current: when you finish a piece of work, update the
relevant section instead of leaving it for the conversation to remember.
Conversations get summarized/compacted; this file doesn't.

## What this is

Aethyro (aethyro.com) is a solo-built AI SaaS: streaming Claude chat, one-time
credit-pack payments, document intelligence, referrals, and an admin
dashboard. No framework — vanilla HTML/JS served from Cloudflare Workers
(git-push auto-deploy), Supabase Postgres for data/auth/RLS, Stripe for
payment, Claude for the model.

Full architecture/page/function/DB audit (score, roadmap, bug list):
https://claude.ai/artifact/ViMiQvZ5Unh4AZweNAptFK — **treat its P0/P1 claims
as unverified.** A spot-check on 2026-09-27 found it flatly wrong about
several headline items (see "Open TODOs" below for the corrected list).
It was produced by an Explore agent summarizing file excerpts rather than
reading full files / hitting the live site, and missed root-level files
entirely. Don't re-cite it without re-checking the specific claim against
the actual repo/live site first.

## Hard security constraint — do not violate

**Never link a raw Stripe Payment Link.** Those carry no user id, so the buyer
gets charged and no credits land. The only correct purchase path is
`chat.html?buy=<pack>`, which routes through the `buy-credits` edge function
(stamps `user_id` into the Stripe session metadata; `stripe-webhook` reads it
back to credit the right account). If you ever see a bare
`buy.stripe.com/...` link proposed anywhere in this repo, that's a bug — fix
it to the `?buy=` pattern instead.

## Database schema gotchas (these have caused real bugs — check before writing SQL)

- **`credit_ledger`** columns: `id, user_id, delta, reason, stripe_session_id, metadata, created_at`.
  The column is **`reason`**, not `note` or `description`. `reason` values:
  `purchase` (well, actually `pack:<name>` for purchases — see below),
  `chat_usage`, `signup_bonus`, `admin_adjustment`, `referral_bonus`.
  Purchase rows use `reason LIKE 'pack:%'` (e.g. `pack:starter`, `pack:value`,
  `pack:power`, `pack:pro_7k`), not a bare `'purchase'` literal.
- **`messages`** columns: `id, conversation_id, role, content, created_at`.
  **There is no `user_id` column.** To scope by user, JOIN:
  `messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ...`.
- **`referral_codes`**: one row per user, 8-char unique `code`, auto-generated
  by a trigger on `profiles` INSERT.
- **`referral_events`**: `referrer_user_id`, `referee_user_id`, UNIQUE on
  `referee_user_id`. RLS SELECT policy `referral_events_select_own`
  (`referrer_user_id = auth.uid() OR referee_user_id = auth.uid()`) is live —
  added by `20260925000001_security_hardening.sql`. Don't add a second
  SELECT policy for this table; check `pg_policies` first if a referral query
  seems to return nothing (the cause is more likely a JS bug than RLS).
- Admin RPCs (`get_admin_stats`, `get_admin_users`, `admin_adjust_credits`)
  are `SECURITY DEFINER` and gate on `public.is_admin()`, which checks
  membership in `public.admin_users` (`user_id, email, created_at`). To add
  a second admin: `INSERT INTO admin_users (user_id, email) VALUES (...)` —
  no code change or redeploy needed. `admin_users` has RLS enabled with zero
  policies (unreachable from the client entirely, even by an admin's own
  session); only `is_admin()` (SECURITY DEFINER) and direct SQL can read it.
  `anon`'s EXECUTE grant was revoked from all three functions too — PostgREST
  now 404s them for anon instead of letting the call reach the function body.
  (Previously hardcoded `auth.jwt() ->> 'email' = 'leer4030@gmail.com'` —
  fixed in `20260927020000_admin_users_table.sql`, closes audit BUG-08.)

## Pending / not yet applied

- `redeem-referral` edge function is called from `chat.html` but its source
  is not in `supabase/functions/` in this repo — it may only exist deployed
  directly in the Supabase dashboard. Pull it into the repo so it's
  version-controlled (audit BUG-04).

## Decommissioned: old per-plan subscription model (2026-09-27)

Aethyro briefly had a $29/$199/$299/$499-per-month subscription model
(`personal`/`research`/`dev`/`cpa` plans) before pivoting to one-time credit
packs. Confirmed with the user this subscription line was abandoned and
should not be reachable. Found via Supabase's edge-function list and
security advisors, not from any doc — `list_edge_functions` showed 18
active functions when only 10 were documented anywhere.

- **`create-checkout`** (the function that sold those plans) is now stubbed
  to return 410 for any caller — it no longer creates real Stripe sessions.
  It *was* properly secured (required auth, stamped `supabase_user_id` into
  Stripe metadata) so this was never a raw-payment-link problem, but it was
  a live, unlinked page (`app/packs.html`, deleted) that could still charge
  someone real recurring money for a plan the current product has zero
  entitlement logic for. `subscriptions`/`purchases`/`licenses` tables exist
  but had ~0 real usage (2 stale `trialing` rows, nothing `active`, 0
  purchases, 0 licenses) — this was a latent risk, not an active incident.
- **`activate-license` / `validate-license` / `customer-portal` are now also
  stubbed to return 410.** These belong to GH05T3 — `activate-license`'s own
  comment says *"the local GH05T3 app calls this"*, a completely separate
  desktop product's license-activation backend that happened to live in this
  same Supabase project. The user confirmed GH05T3 is dead too, and it's
  confirmed dead by data, not just inference: `licenses` has **0 rows,
  ever** (activate-license has never once succeeded for a real device), and
  a direct Stripe API check (not just this DB) found exactly **one**
  subscription in this account's entire history — a $500/mo "Pro" plan
  (a different price than create-checkout's 4-tier grid), trialed in
  August 2026, whose first real charge failed and was canceled for
  `payment_failed`. Total lifetime revenue from this whole system: $0.
  All four stub sources now live in `supabase/functions/{create-checkout,
  activate-license,validate-license,customer-portal}/index.ts` for version
  control. `subscriptions`/`purchases`/`licenses` tables were left in place
  as historical record, not dropped.
- Offline-license design note, for future reference: the (now-retired)
  system was legitimately well-built — RS256-signed JWTs verified **offline**
  by the desktop app via an embedded public key, 7-day offline grace period,
  optional online re-check. Worth reusing the pattern if a licensed desktop
  product is ever built again; the implementation just never had a paying
  customer.
- `pricing.html` was checked and is fine — it's current (credit-pack
  pricing, CTAs go to `/app/signup.html`), it just contains the word
  "subscriptions" in a "no subscriptions" sentence, which is a false
  positive if you're grep'ing for the old model.
- Not yet checked: `marketplace/`, `contractors.html`, `app/community.html`
  content for other stale references to the old model — flagged for
  awareness, not yet acted on.

## Key config

- Supabase project ref: `uzmdqbtflcpikjdrggqc`
- Supabase URL/anon key: `app/config.js` (anon key is safe to expose; RLS does
  the real access control — never put a service-role key in client code)
- GA4: `G-BE319Z71PD` on every page
- Production domain: `aethyro.com`

## Conventions

- CSS tokens (dark theme, used across `app/*.html`): `--text:#f0f0f0`,
  `--muted:#888`, `--surface:#141414`, `--border:#2a2a2a`, `--mono`, accent
  `#ff4d00`. Match these rather than inventing new colors.
- Fonts: Space Grotesk (display) + JetBrains Mono (mono), loaded from Google
  Fonts.
- `app/*.html` pages carry `<meta name="robots" content="noindex,nofollow">`
  — intentional, keep it (they're logged-in app surfaces, not marketing pages).

## Recent work log

Keep this short — a few most-recent entries, not a full history (git log has
that). Newest first.

- **2026-09-27** — Built referral UI in `app/dashboard.html` (code display,
  copy buttons, referral count, credits earned). Fixed credit-history label
  bug that read nonexistent `row.description`/`row.type` instead of
  `row.reason`. Ran a full site audit (published as the artifact linked
  above). PR #69. Added a `20260927000001_referral_events_select_policy.sql`
  migration on the assumption `referral_events` had no SELECT policy — turned
  out wrong: `20260925000001_security_hardening.sql` (two days earlier) had
  already added an equivalent, broader policy live. Deleted the redundant
  migration file rather than apply it (PR #71). Lesson: check `pg_policies`
  against the live DB before writing an RLS migration, don't infer from
  reading migration files alone.
- **Earlier** — Fixed admin dashboard SQL functions that referenced wrong
  column names (`credit_ledger.note` → `.reason`, `messages.user_id` → join
  via `conversations`). PR #68.

## Open TODOs (verified against the actual repo/live site on 2026-09-27 —
this list supersedes the audit artifact above where they conflict)

**Already done, despite what the audit claimed — don't redo these:**
- `terms.html` / `privacy.html` — exist, real Aethyro-specific content, live
  (200), linked from `index.html` footer as `/terms.html` / `/privacy.html`.
- `sitemap.xml`, `robots.txt` — exist, live (200).
- OG tags, Twitter card, JSON-LD (Organization + WebSite schema) — all
  present in `index.html`'s `<head>`.
- Branded 404 page — `404.html` exists and is actually served live
  (verified: unknown path returns Aethyro-styled 404, not a Cloudflare
  default).
- Blog — `blog/index.html` + real posts exist and are live.

**Confirmed still true — actual open work:**
- P0: **Fabricated testimonials.** The three landing-page quotes ("Alex M."
  CTO, "Rachel T." consultant, "Sami K." platform engineer) are invented,
  detailed personas, not real users. Needs real quotes or removal.
- ~~P2: PWA `manifest.json` had empty `screenshots: []`~~ — **fixed
  2026-09-27**. Added real screenshots of the live site (`/screenshots/
  wide.png` 1280x800, `/screenshots/narrow.png` 390x844 — Playwright against
  `https://aethyro.com/`, not mockups) with `form_factor: wide/narrow`.
- ~~P2: Admin access is a hardcoded email check~~ — **fixed 2026-09-27**, see
  the `admin_users`/`is_admin()` note above.

**Not yet re-verified — check before acting, don't assume the audit is right:**
email-drip cron automation, in-app nav between dashboard/chat,
`redeem-referral` function source location, rate limiting, skeleton
loaders, everything in the audit's P3 section.
