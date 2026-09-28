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
- **`memory_embeddings.conversation_id`** is **`text`, not `uuid`** — it
  isn't a foreign key to `conversations.id`. Cast when comparing:
  `conversation_id = p_conversation_id::text`.
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
- **`auth.users` has four triggers, and not all of them are in this repo's
  migration history.** Before assuming a signup-time behavior is fully
  described by `grep`-ing `supabase/migrations/`, check `pg_trigger` live:
  `on_auth_user_created` (`handle_new_user()` — creates the `profiles` row;
  as of `20260927225844_fix_duplicate_signup_bonus.sql` that's now the
  *only* thing it does), `on_auth_user_created_grant_bonus`
  (`grant_signup_bonus()`, from `20260901000001_...` — the one and only
  place the 200-credit signup bonus should be granted),
  `on_auth_user_created_queue_emails` (`queue_onboarding_emails()`), and
  `on_auth_user_created_welcome` (`trigger_welcome_email()`, fires
  `send-welcome-email` via `pg_net.http_post` with a **hardcoded anon key
  literal in the function body** — works, but means the key is baked into
  a DB function definition, not read from a secret; worth revisiting if the
  anon key is ever rotated). `handle_new_user()` predates this repo's
  migration history entirely — it was never defined by a committed
  migration, only ever edited live (dashboard/SQL editor). Don't assume a
  trigger you can't find in `supabase/migrations/` doesn't exist.
- **There are 4 live `pg_cron` jobs, none previously documented here** —
  check `select * from cron.job` live, don't assume the trigger list above
  is the whole picture of what runs automatically. `send-onboarding-emails`
  (`*/30 * * * *`) drains `scheduled_emails` and calls `send-onboarding-email`
  for `email_num` 1-3 (`queue_onboarding_emails()` only ever inserts 1-3, one
  per day after signup — content fixed 2026-09-27, see recent-work-log).
  `cleanup-trial-usage-daily`
  (`0 3 * * *`) calls `cleanup_old_trial_usage()`. `drip-engagement`
  (`5 9 * * *`) and `drip-reengagement` (`15 9 * * *`) both call
  `send-welcome-email` for users 2/5 days old respectively who haven't had
  that drip stage yet (tracked in `email_drip_state`) — same hardcoded
  anon-key-literal pattern as `trigger_welcome_email()`, same rotation
  caveat applies to these two job definitions as well.
- **Edge function drift is a recurring failure mode in this project, not a
  one-off** — `redeem-referral` (BUG-04, fixed 2026-09-27) was the first
  case found; a `site-guardian` sweep the same day found four more live
  functions with zero source in this repo: `send-newsletter`,
  `send-onboarding-email`, `trial-chat`, `send-low-credit-email` (now all
  pulled in, see recent-work-log). Anything deployed straight from the
  Supabase dashboard/CLI instead of through this repo's normal path will
  silently drift — `list_edge_functions`' `entrypoint_path` is a tell (a
  path like `/Users/leer4/Documents/supabase-local/...` or a bare `/tmp/...`
  with no matching file in `supabase/functions/` means it was deployed
  outside this repo). Worth a `list_edge_functions` vs. `ls
  supabase/functions/` diff periodically, not just when a bug forces it.

## Pending / not yet applied

~~- `referral_events`'s two FKs to `auth.users` were `NO ACTION`~~ — **fixed
  2026-09-27**, see the recent-work-log entry below.
~~- New accounts get the 200-credit `signup_bonus` twice~~ — **fixed
  2026-09-27**, see the recent-work-log entry below.

~~- `send-onboarding-email`'s templates described a completely different
  product~~ — **fixed 2026-09-27**, see the recent-work-log entry below.
~~- 8 unrelated agent-simulation tables didn't belong to Aethyro~~ — **dropped
  2026-09-28**, see the recent-work-log entry below.
~~- Leaked-password protection isn't active~~ — **checked 2026-09-28, not a
  bug.** The earlier finding was wrong on the key point: `signup.html`
  **does** have a working client-side HaveIBeenPwned check (`isPasswordLeaked()`
  around line 93 — SHA-1 hash, k-anonymity range query to
  `api.pwnedpasswords.com`, blocks the form submit with a clear error before
  `supabase.auth.signUp()` is ever called). The earlier grep only searched
  for the string `check-leaked-password` and missed this because it's an
  inline reimplementation, not a call to that edge function. Verified live:
  hit the real HIBP range API for a known-leaked password
  (`password123` → 2,266,543 breach count) and confirmed the same
  suffix-match logic `signup.html` uses would correctly flag it.
  Separately, `auth_leaked_password_protection` (the *built-in* Supabase
  Auth toggle) really is off — but that's because **this project is on the
  Supabase Free plan**, and per Supabase's own docs, leaked-password
  protection at the Auth-service level requires Pro plan or above; it
  isn't purchasable/enableable at all on Free (confirmed via
  `get_organization`: `plan: "free"`). This is also exactly why
  `check-leaked-password`'s own code comment says the client-side check in
  `signup.html` is "the primary defense" — the free-tier `before_user_created`
  hook payload doesn't even include the plaintext password, so wiring that
  edge function up as an Auth Hook right now would be a guaranteed no-op
  (fail-open every time). Nothing to fix here unless/until this project
  upgrades to Pro — at which point `check-leaked-password` is already
  written and ready to wire in as the Auth Hook.

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

- **2026-09-28** — **Fixed: homepage nav showed "Log in" for already
  signed-in users** (user-reported: "sign in, hit the Aethyro logo back to
  home, it doesn't stay signed in"). Root cause: `index.html` has **zero**
  session awareness anywhere — it never loads the Supabase JS client
  (deliberately kept off the homepage, see the render-blocking/unused-JS
  cleanup below) and never calls `supabase.auth.getSession()`, so its nav
  ("Log in" link, desktop + mobile drawer) is fully static regardless of
  actual auth state. Verified live with a real throwaway account that the
  session itself was never actually lost — same
  `sb-uzmdqbtflcpikjdrggqc-auth-token` localStorage key present and valid
  on the homepage, navigating straight into `chat.html` from there didn't
  bounce to login — it was purely a nav-display bug, not a real
  sign-out. Fixed with a small inline script (no SDK load, no network
  request) that reads that same shared localStorage key and swaps
  "Log in" → "Dashboard" on both nav locations when a session with a
  `refresh_token` is present. Verified both directions: signed-in shows
  "Dashboard" (desktop + mobile drawer, screenshotted), and clearing the
  session + reloading correctly falls back to "Log in" — not just the
  happy path. Left the footer's Account column and the ⌘K command
  palette's `Log in`/`Dashboard` entries alone (they're static
  destination lists, not a status indicator, same as before).
- **2026-09-28** — **Added real usage charts** (user asked for "graphs and
  charts... for the intelligent aspect of the AI"). Hand-rolled inline-SVG
  charts, same technique `dashboard.html` already used for its 30-day
  credit-usage sparkline — no new chart library, consistent with this
  repo's vanilla/no-framework approach and the performance work above.
  (1) **`dashboard.html`: Model mix — last 30 days** panel, right below
  the existing sparkline — horizontal bars showing the Haiku/Sonnet/Opus
  split of credits spent. Required a real gap-fix first:
  `chat`'s `finalize()` was inserting `chat_usage` rows into
  `credit_ledger` with **no `metadata` at all** — the per-message
  `model`/token breakdown was streamed to the client (`USAGE_MARK`) but
  never persisted, so there was no historical data to chart from. Fixed
  in `supabase/functions/chat/index.ts` (now stores
  `metadata:{model,input_tokens,output_tokens}` on every usage row,
  deployed live). Rows from before this deploy have `metadata: null` and
  are excluded from the chart rather than counted as "unknown" — the
  panel says so explicitly when there's no post-deploy data yet.
  (2) **`chat.html`: Memory growth — last 30 days** sparkline at the top
  of the Intelligence panel's Memory tab, showing new `memory_embeddings`
  rows per day. Verified live end-to-end with real data, not synthetic
  rows: created a real throwaway account (temporary `test-admin-setup`
  helper, same pattern as the PR #77 verification — deleted after, function
  re-stubbed to 410), signed in via Playwright, sent two real messages
  through the actual chat UI (Opus, real token counts), then confirmed the
  Memory sparkline rendered "4 memories" with correct labels and the
  dashboard Model Mix panel rendered a single 100% Opus / 4cr bar matching
  exactly what was spent. Zero console errors on either page. Cleaned up:
  deleted the throwaway account, confirmed zero orphaned rows across
  `credit_ledger`/`memory_embeddings`/`conversations`/`profiles`/
  `referral_codes`/`auth.users`, re-stubbed `test-admin-setup` to 410.
  `chat` edge function now at v33.
- **2026-09-28** — **Homepage performance/accessibility pass** (PR #91),
  from a real PageSpeed Insights/Lighthouse mobile audit (Performance 83,
  Accessibility 86-87, Best Practices/SEO 100). Fixed the specific flagged
  items, no visual changes: (1) the Google Fonts `<link rel="stylesheet">`
  was synchronous/render-blocking (the audit's single largest flagged
  item, ~1s estimated) — switched to the preload + `media="print"
  onload="this.media='all'"` swap pattern with a `<noscript>` fallback;
  (2) `gtag.js` now loads via `requestIdleCallback` (1.5s `setTimeout`
  fallback) instead of eagerly, so it stops competing with first paint —
  `dataLayer`/analytics events unaffected, just deferred a beat; (3)
  `--t3` (`#555`, used in ~40 small caption/label elements site-wide) was
  ~2:1 contrast against `--bg`, failing WCAG AA's 4.5:1 — bumped to
  `#7a7a7a` (~4.8:1), one token fixes all usages; (4) two `<h2>`→`<h4>`
  heading-order skips (the "How it works" steps, the footer columns) —
  changed both to `<h3>`, zero visual change since styling comes from
  class selectors not tag defaults; (5) added a `<main>` landmark — the
  page had none — wrapping the hero through the last content section.
  Verified locally with Playwright against the real file: `<main>` count
  and scope correct, zero remaining `<h4>` skips, `--t3` computed value
  confirmed, fonts still load (`document.fonts.check` passes) under the
  new preload pattern, GA `dataLayer` still receives events under the
  deferred loader, zero console errors, full-page screenshot shows no
  regression. Not yet addressed from the same audit (real code/behavior
  changes, wanted a second pass first): ~73KB "unused JavaScript" (almost
  certainly mostly `gtag.js` itself, not first-party code — this repo's
  only JS is one inline `<script>` block, no bundled/legacy JS of its
  own) and asset cache lifetimes for third-party resources outside this
  repo's control (Google Fonts, GA).
- **2026-09-28** — **Fixed: mobile nav drawer rendered fully transparent
  over page content** (user-reported, with a real Android Chrome
  screenshot showing the hero headline/CTAs and the drawer's own link
  text simultaneously legible, overlapping). Root cause:
  `.nav-drawer` (`position:fixed;inset:0`) was nested **inside** `<nav>`,
  and `<nav>` has `backdrop-filter:blur(20px)`. Any element with a
  non-`none` `backdrop-filter` becomes the **containing block** for
  `position:fixed` descendants (same rule as `transform`/`filter`) — so
  the drawer's fixed box was being sized to `<nav>`'s own ~60px bar
  height instead of the viewport. Its opaque background only painted
  within that ~60px strip; the drawer's own content (links padded `5rem`
  from the top) rendered far below it with nothing opaque behind it,
  letting the whole hero section bleed through underneath the drawer's
  own text. Spent significant diagnostic effort ruling out backdrop-filter
  support, CSS transitions, z-index/stacking, and duplicate markup before
  finding this — the giveaway was forcing an unmissable `!important`
  magenta override on the drawer and seeing only a ~60px strip (matching
  nav's height, not the viewport) actually turn opaque. Fixed by moving
  `.nav-drawer`'s markup to be a **sibling** of `<nav>` instead of a
  child. Verified: reparented the element live via Playwright DOM
  mutation first to confirm the theory before touching the real file;
  after editing `index.html`, served it locally and re-verified
  `isChildOfNav: false`, fully opaque drawer with zero bleed-through,
  open/close toggle still correct (`aria-hidden`, `body.style.overflow`
  lock), and desktop layout unaffected. Confirmed via `grep` no other
  page shares this markup, so nothing else needed the same fix. PR #90.
- **2026-09-28** — **Closed the last `site-guardian` escalation — turned
  out not to be a bug.** Investigated the "leaked-password protection
  isn't active" finding to actually fix it, and found the earlier finding
  itself was wrong: `signup.html` already has a real, working client-side
  HaveIBeenPwned check (missed by the earlier grep because it's an inline
  reimplementation, not a call to the `check-leaked-password` edge
  function by name). Verified live against the real HIBP range API with a
  known-leaked password to confirm the logic actually works. Separately
  confirmed via `get_organization` that this project is on Supabase's
  **Free plan**, and per Supabase's own docs the built-in
  `auth_leaked_password_protection` toggle requires Pro plan or above —
  it's not an oversight, it's unavailable to enable at all on this tier,
  which is also exactly why `check-leaked-password`'s own code comment
  already says the client-side check is "the primary defense" for now.
  No code changed; corrected the record in "Pending" above so this doesn't
  get re-flagged as broken by a future sweep. If this project ever
  upgrades to Pro, `check-leaked-password` is already written and ready to
  wire in as a real Auth Hook.
- **2026-09-28** — **Dropped 8 unrelated tables and their 4 functions**
  (the agent-simulation-schema finding from the `site-guardian` sweep, on
  explicit instruction): `agents`, `economy_ticks`, `agent_fitness_history`,
  `auctions`, `trades`, `agent_events`, `species`, `economy_config`, plus
  `get_leaderboard()`, `find_similar_agents()`, `get_agent_trend()`,
  `get_economy_summary()` (the only functions that referenced them).
  Re-verified live immediately before dropping, not just trusting the
  sweep's earlier finding: all 8 tables still had zero rows
  (`pg_stat_user_tables.n_live_tup`), zero FK relationships to/from any
  Aethyro table (`pg_constraint`), and the 4 functions were confirmed
  unreferenced anywhere in this repo despite being `EXECUTE`-granted to
  `authenticated`. Verified after dropping: `list_tables` shows only
  Aethyro's own tables, `get_advisors` no longer lists any of the 8
  tables' GraphQL-exposure warnings or the 4 functions'
  `SECURITY DEFINER`-exposure warnings, and no other advisory finding
  changed. Migration: `20260928002700_drop_unrelated_agent_sim_schema.sql`.
- **2026-09-28** — **Rewrote `send-onboarding-email`'s content** (the
  stale-product finding from the `site-guardian` sweep below). The old
  templates sold the decommissioned $29–499/mo subscription plans, a
  local-Ollama install flow, a 14-day trial, and six fictional agent
  personas — none of it matched the real product. Also found while fixing
  it: `queue_onboarding_emails()` (the trigger that actually schedules
  these) only ever inserts `email_num` 1-3, one per day after signup —
  templates 4 and 5 were dead code, unreachable by any real signup, not
  just wrong. Removed them rather than inventing content for a path that
  doesn't fire. Rewrote 1-3 with real facts only: the actual 200-credit
  signup bonus (permanent, not a trial), real model names (Haiku/Sonnet/
  Opus, not personas) and their real per-message credit costs, the actual
  Intelligence panel features (agentic tasks, document knowledge base,
  scheduled routines, memory, GitHub/Notion connectors), the real referral
  bonus (100 credits each side), and real credit-pack pricing ($4/200cr up
  to $90/7000cr, via `/#pricing`, never a bare Stripe link). Verified live:
  deployed the function, sent all 3 real templates to the admin's own
  inbox via direct calls to `send-onboarding-email` (never a real
  customer), confirmed all three delivered with real Resend message ids,
  and confirmed `email_num: 4` now returns a clean `400` instead of
  sending stale content.
- **2026-09-27** — First `site-guardian` sweep (see that skill). Pulled four
  more drifted edge functions into the repo verbatim, no behavior change —
  `send-newsletter`, `send-onboarding-email`, `trial-chat`,
  `send-low-credit-email` — closing the same class of gap `redeem-referral`
  (BUG-04) was. Also ran `get_advisors` (security+performance),
  cross-checked `pg_trigger`/`pg_cron.job` against this file, live-tested
  the homepage's anonymous `trial-chat` endpoint (works — its hardcoded
  `"claude-opus-5"` model string is fine, verified with a real streamed
  reply, not a stale/broken id despite looking similar to the earlier
  `MODEL_MAP` bug). Found and escalated (not fixed — real product/content
  decisions, see "Pending" above): `send-onboarding-email`'s templates
  describe a dead product (old subscription pricing, fictional agent
  personas, local-Ollama flow) and are still live-dispatched by an
  undocumented `pg_cron` job every 30 minutes; 8 unrelated
  agent-simulation-looking tables with zero rows and zero references
  anywhere in this repo; leaked-password protection is off both at the
  Supabase Auth level and in this repo's own unwired `check-leaked-password`
  function. Also hardened `trigger_welcome_email()` — see below.
- **2026-09-27** — **Hardened `trigger_welcome_email()`** (found by the
  `site-guardian` sweep above): it had no `SET search_path` (unlike every
  other `SECURITY DEFINER` function here) and was directly callable via
  `/rest/v1/rpc/trigger_welcome_email` by anyone, signed in or not — it's
  meant to run only as the `on_auth_user_created_welcome` trigger (it
  references `NEW`, which only exists in trigger context). Fixed both:
  added `SET search_path TO ''`, and `REVOKE EXECUTE ... FROM PUBLIC`
  (learned mid-fix that revoking from just `anon`/`authenticated` is a
  no-op — both are implicitly members of `PUBLIC`, which still held the
  grant; had to check `information_schema.routine_privileges` to catch
  this). Verified live: a real throwaway signup after the fix still
  produced a successful `net._http_response` row
  (`{"ok":true,"type":"welcome"}`, 200) — trigger execution runs as the
  function owner regardless of caller privileges, so the revoke doesn't
  break it — and a direct anon RPC call now 404s, matching the
  `admin_users` RPC pattern from `20260927020000_admin_users_table.sql`.
  Migration: `20260927234300_harden_trigger_welcome_email.sql`.
- **2026-09-27** — **Fixed: `referral_events`'s two FKs to `auth.users` were
  `NO ACTION`, making any account that ever sent or redeemed a referral
  permanently undeletable** (found while spot-checking `redeem-referral`,
  see the entry below). Migration `20260927230500_referral_events_cascade_delete.sql`
  switches both `referrer_user_id` and `referee_user_id` FKs to
  `ON DELETE CASCADE`, matching every other user-owned table in this schema.
  Verified live end-to-end, not just the constraint definition: created a
  real referrer + referee throwaway pair, redeemed a real referral between
  them via `redeem-referral` with a real password-grant session (confirmed
  the `referral_events` row existed first), then called
  `auth.admin.deleteUser()` on both — referee first (the `UNIQUE` side,
  where the old bug hit hardest), then referrer. Both succeeded (`{deleted:
  true}`, no `"Database error deleting user"`). Confirmed zero orphaned rows
  left behind anywhere (`referral_events`, `credit_ledger`, `profiles`,
  `referral_codes`, `auth.users` all zero for both test ids) — the cascade
  didn't just stop erroring, it actually cleaned up correctly.
- **2026-09-27** — **Fixed: every new signup was granted the 200-credit
  `signup_bonus` twice** (found incidentally while spot-checking
  `redeem-referral`, see the entry below). Root cause: two independent
  triggers on `auth.users` both grant it — `on_auth_user_created` ->
  `handle_new_user()`, an old trigger that predates this repo's migration
  history entirely (never defined by a committed migration, only ever
  edited live via the dashboard/SQL editor), and
  `on_auth_user_created_grant_bonus` -> `grant_signup_bonus()`, added later
  by `20260901000001_auto_grant_signup_bonus.sql` — apparently without
  whoever wrote that migration knowing `handle_new_user()` already granted
  it, since it isn't in this repo. `handle_new_user()` was *also* writing a
  `'trial'`/`'trialing'` row into the decommissioned `subscriptions` table
  on every signup — see "Decommissioned: old per-plan subscription model"
  below; that's very likely the source of the "2 stale `trialing` rows"
  mentioned there, and it was still actively growing before this fix.
  Checked live before writing the fix: zero real signups have happened
  since 2026-09-01 (when the second trigger was added) — only 2 real
  accounts exist in this project total, both predate that date, neither
  double-credited. **No user balance needed correcting; this was a live
  bug with no actual victims yet, caught before it hit anyone.** Fixed by
  stripping `handle_new_user()` down to just the `profiles` insert (still
  needed — `referral_codes` generation depends on a trigger on `profiles`
  INSERT) — removed its duplicate `credit_ledger` insert and its
  `subscriptions` insert. Migration:
  `20260927225844_fix_duplicate_signup_bonus.sql`. Verified live with a
  fresh throwaway signup: exactly one `signup_bonus` row (not two),
  `profiles` row created correctly, `referral_codes` still auto-generated,
  zero new `subscriptions` rows.
- **2026-09-27** — Spot-checked `redeem-referral` (audit BUG-04: its source
  wasn't in the repo, only deployed via the Supabase dashboard). Pulled the
  live source into `supabase/functions/redeem-referral/index.ts` — it's
  correct and now committed. Verified live with two throwaway accounts (a
  real referrer + referee, signed in via password grant for a real session
  token, not just a service-role shortcut): happy path credits both sides
  `+100 reason='referral_bonus'`; duplicate redemption → 409; self-referral
  → 400; invalid code → 404. All four passed. Found two things while
  testing, neither fixed yet — both written up under "Pending / not yet
  applied" above: `referral_events`'s FKs to `auth.users` are `NO ACTION`
  instead of `CASCADE` like every other table here, so a user who's ever
  been on either side of a referral can never have their account deleted;
  and new signups are getting the 200-credit `signup_bonus` **twice**, not
  once (found incidentally, not yet root-caused).
- **2026-09-27** — Verified the low-credit-warning email fix (entry below)
  actually delivers, not just that the internal call stops 401ing. Called
  `send-low-credit-email` directly (with the now-fixed `X-Internal-Key`
  header) against the real admin account (`leer4030@gmail.com`, user_id
  `422eecb9-2fb5-4e4e-9bd6-47f9433e8a56`) with a synthetic `balance: 25` —
  no real credit data touched. Resend accepted it and returned a real
  message id (`01a0e50b-1046-764d-87ba-a4312eb0b042`). Side effect,
  expected and correct: this set that account's `profiles.low_credit_warned_at`
  to the send time, starting a real 7-day cooldown — same as any genuine
  send would. **Gotcha for next time:** before this fix, `chat`'s
  `finalize()` called `send-low-credit-email` without checking whether the
  invoke succeeded, then unconditionally set `low_credit_warned_at` anyway
  — so any real user whose balance ever dropped to ≤30 credits had their
  cooldown silently poisoned (marked "warned" while never actually
  receiving anything). If a real user reports never getting a low-credit
  email even now, check `profiles.low_credit_warned_at` for a stale
  pre-fix timestamp blocking a real send — clearing it to `NULL` resets
  their eligibility.
- **2026-09-27** — **Root-caused and fixed why `memory_embeddings` was never
  getting written** (flagged as an open question in the entry below). Two
  distinct bugs, found via a `waitUntil()`-only fix that *partially* worked
  (structured `profiles.memory` JSONB extraction started succeeding, proving
  the isolate-freeze theory right) but still left zero rows in
  `memory_embeddings` — meaning a second, independent bug had to exist:
  1. **`EdgeRuntime.waitUntil()` missing** — the fire-and-forget memory block
     in `chat`'s `finalize()` wasn't handed to `EdgeRuntime.waitUntil()`, so
     Supabase's edge runtime could freeze/recycle the isolate the instant
     `controller.close()` ran, killing whatever background work hadn't
     finished yet. No error, nothing thrown.
  2. **`supaAdmin.functions.invoke()` doesn't auto-send `Authorization`** —
     confirmed live with a diagnostic probe: calling `embed-content` via
     `supaAdmin.functions.invoke()` with *default* headers got a 401 from
     `embed-content`'s own `jwt === SERVICE_ROLE_KEY` check; the identical
     call with an explicit `headers: {Authorization: Bearer <key>}` returned
     200. Root cause: this project's service-role key is one of Supabase's
     newer `sb_secret_...`-format keys (confirmed via a second probe —
     `sr_key_prefix: "sb_secre"`), and `supabase-js`'s default
     header-injection for `.functions.invoke()` doesn't forward that format
     the way it does a legacy JWT-format key. **Same bug, different failure
     mode, hit `send-low-credit-email` even harder — that call was never
     going to work regardless, since `send-low-credit-email` doesn't check
     `Authorization` at all; it checks a custom `X-Internal-Key` header that
     `chat` never set. That email has never been sent, ever, since it was
     added.** Fixed: every `supaAdmin.functions.invoke()` call in
     `chat/index.ts` now passes its target function's required header
     explicitly (`Authorization: Bearer <service-role-key>` for
     `embed-content`, `X-Internal-Key: <service-role-key>` for
     `send-low-credit-email`) — deployed live as v32/v34. Verified live,
     twice: (1) a diagnostic edge function isolated the exact
     default-vs-explicit-header behavior difference before touching
     production code; (2) after deploying the fix, a real chat message
     through a throwaway account produced real `memory_embeddings` rows
     (both `user` and `assistant` turns, `has_embedding: true`) for the
     first time. **If you add a new `supaAdmin.functions.invoke(...)` call
     anywhere in this codebase, pass its Authorization/internal-auth header
     explicitly — do not rely on the client's default headers.** Also worth
     checking: whether other Supabase projects/functions using the newer
     `sb_secret_...` key format have the same latent bug anywhere else they
     call `.functions.invoke()` without explicit headers.
- **2026-09-27** — **P0 fixed: every Sonnet/Opus chat message was failing
  live in production** with a 400 (`"thinking.type.enabled" is not supported
  for this model. Use "thinking.type.adaptive"...`). Found while manually
  verifying PR #77's test plan against the real site with a throwaway test
  account (created via a temporary admin edge function, deleted after) — the
  very first live chat send failed. Root cause: `claude-opus-5-5` and
  `claude-sonnet-5` (this app's `opus`/`sonnet` model keys) reject the
  deprecated `thinking: {type:"enabled", budget_tokens:N}` shape entirely;
  only `{type:"adaptive"}` is accepted now. This had been broken since
  whichever prior session/PR introduced `MODEL_MAP.opus = "claude-opus-5-5"`
  — Haiku has no `thinking` param at all, so Haiku chats kept working and
  masked it in every manual spot-check that happened to use the default
  model. Fixed in `supabase/functions/chat/index.ts` (deployed live as v30/v32:
  `thinking: {type:"adaptive", display:"summarized"}`, dropped the
  now-invalid `THINKING_BUDGET` constant). Re-verified live after the fix:
  a real message now returns a real reply with a correct cost badge (`1
  credit · 36 in / 4 out tokens · opus`). **If you add a new model to
  `MODEL_MAP`, check the current API's `thinking` requirements for it before
  shipping — don't assume the existing `{enabled, budget_tokens}` shape
  still applies.**
- **2026-09-27** — Manually verified PR #77's test plan end-to-end against
  the live site (not just DB/RLS-level checks): created two confirmed
  throwaway accounts via a temporary `test-admin-setup` edge function
  (`auth.admin.createUser({email_confirm:true})`, bypassing the normal
  email-confirmation flow since signup.html requires a real inbox), drove
  both through Playwright. Results: cost badge/session pill — passed after
  the thinking-param fix above; per-entry memory delete — passed (seeded one
  synthetic `memory_embeddings` row since the real auto-embed pipeline
  wasn't landing rows fast enough in-test to click against, see note below);
  routine publish → community gallery → fork → fork_count increment —
  passed on the first try; deletion receipt (payload, HMAC signature,
  Verify button, JSON download) — passed on the first try. Cleaned up: both
  test accounts deleted (cascade confirmed zero leftover rows across
  `conversations`/`user_routines`/`memory_embeddings`/`deletion_receipts`/
  `credit_ledger`), `test-admin-setup` stubbed to 410 (no MCP tool exists to
  actually delete an edge function). **Not yet root-caused:** a real
  successful chat exchange did not produce a `memory_embeddings` row for the
  test account within several seconds — either `VOYAGE_API_KEY` isn't set as
  a project secret, or the fire-and-forget `embed-content` invocation from
  `chat`'s `finalize()` is failing silently (it's wrapped in a bare `catch
  {}`). Worth a real investigation; flagged here rather than chased further
  since it's outside PR #77's scope.
- Four "rare feature" differentiators (user asked to
  deprioritize the testimonials P0 in favor of these): (1) **Visible/editable
  memory graph** — turned out to already exist (chat.html's Intelligence →
  Memory tab: structured `profiles.memory` fact chips with per-key delete,
  raw `memory_embeddings` log with search); only gap was per-entry delete on
  the raw log, added. No migration needed — RLS on `memory_embeddings`
  already permitted owner CRUD. (2) **Forkable routines** — `user_routines`
  gained `is_public`/`fork_count`/`forked_from` columns, an additive
  `routines_public_read` SELECT policy (OR'd with the existing owner-only
  `routines_own` ALL policy, never narrows it), and a `fork_routine(uuid)`
  SECURITY DEFINER RPC; chat.html's Routines tab got a Publish/Make-private
  toggle per routine and a "Community Gallery" list with a Fork button.
  Forked routines land disabled by default. (3) **Real-time cost
  transparency** — the `chat` edge function (v29→v31 deployed) already
  computed exact credit cost from real token counts in `finalize()`, it just
  never left the server; now `USAGE_MARK`'s JSON includes
  `cost:{credits,model,inputTokens,outputTokens,inputRate,outputRate}` and
  chat.html renders it under each assistant bubble plus a running session
  total pill in the topbar. No fabricated "you saved X%" claims — every
  number shown is server-computed. (4) **Verifiable deletion receipts** —
  new `app_secrets` table (zero RLS policies, same unreachable-from-client
  pattern as `admin_users`; seeded with a random HMAC key via `pgcrypto`,
  already installed) and `deletion_receipts` (owner-SELECT-only RLS); a
  `delete_conversation_with_receipt(uuid)` RPC deletes `memory_embeddings`,
  `messages`, and the `conversations` row explicitly (not relying on FK
  cascade), builds a payload, signs it with `hmac(payload::text, key,
  'sha256')`, stores and returns the receipt; a companion
  `verify_deletion_receipt(uuid)` RPC recomputes the signature server-side
  so a user (or anyone auditing) can confirm a receipt wasn't forged.
  chat.html's `deleteConversation()` now calls this RPC instead of a raw
  `.delete()` and shows a modal with the JSON payload, signature, a Verify
  button, and a download-as-JSON button. `get_advisors` security scan run
  after applying — only the same INFO/WARN-level findings every other table
  in this project already has (RLS-enabled-no-policy on the new zero-policy
  table is intentional; GraphQL-schema-visible warnings are boilerplate that
  fires on all 25+ tables regardless of RLS; the three new SECURITY DEFINER
  RPCs are `authenticated`-only, confirmed absent from the anon-executable
  list). Migrations: `20260927030000_forkable_routines.sql`,
  `20260927040000_deletion_receipts.sql`. `chat` edge function source
  updated to v29 in `supabase/functions/chat/index.ts`.
- Built referral UI in `app/dashboard.html` (code display,
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
