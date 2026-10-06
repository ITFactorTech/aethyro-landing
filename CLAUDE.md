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
  `purchase`, `chat_usage`, `signup_bonus`, `admin_adjustment`, `referral_bonus`.
  ~~Purchase rows use `reason LIKE 'pack:%'`~~ — **this was wrong, corrected
  2026-09-28.** A real purchase's `reason` is the bare literal `'purchase'`
  (confirmed directly against `stripe-webhook`'s `grantPackCredits()` and the
  live `credit_ledger_purchase_session_idx` partial unique index definition,
  both of which say `WHERE reason = 'purchase'`). The pack name
  (`starter`/`value`/`power`/`pro_7k`) lives in **`metadata.credit_pack`**,
  not in `reason`. This file's own earlier claim had it backwards and was
  never caught because zero real purchases existed to check it against
  until auto-topup's development surfaced it — `dashboard.html`'s credit
  history had the same bug (`row.reason.replace(/^pack:/, ...)`, which
  never matched anything real), fixed in the same PR that fixed this note.
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
  **A second, opposite-direction flavor of this same failure mode, found
  2026-09-28: committed source can be *ahead* of what's deployed, not just
  behind it.** `git push` auto-deploys this repo's frontend (Cloudflare
  Workers), but nothing auto-deploys a Supabase edge function — that
  always needs an explicit `deploy_edge_function` call. A cross-PR
  merge-conflict resolution that edits `supabase/functions/*/index.ts`
  (as opposed to a fresh feature build, which always ends in its own
  deploy) is easy to land in `main`'s git history without ever
  redeploying it — see the PR #97 auto-model-routing regression in
  recent-work-log below for exactly this happening. Don't assume a
  function is current just because its source is correct in `main`:
  `get_edge_function` and diff its live source against the repo,
  especially for any function touched by a conflict resolution rather
  than its own PR's deploy step.
- **A `SECURITY INVOKER` (the default) aggregate function over a
  restrictively-RLS'd table silently under-counts for anyone but the row
  owner — it won't error, it'll just return a wrong number.** Found live
  2026-09-28 fixing `get_credit_balance` for team pools:
  `credit_ledger`'s only SELECT policy is `user_id = auth.uid()` (own
  rows only), so a non-owner team member's call — even with the
  function's own `WHERE team_id = X` correctly written — had that RLS
  policy ANDed in underneath, silently narrowing the sum to only rows
  *that caller* created. Two real accounts on the same team showed
  different pooled balances until this was caught. Fix is
  `SECURITY DEFINER`, but only when the function is provably safe to run
  with elevated rights (here: it only ever returns one aggregate integer,
  never raw rows) — and when you do this, re-check every overload's
  grants individually with
  `has_function_privilege(role, oid, 'EXECUTE')`, not just by re-reading
  your own `REVOKE`/`GRANT` statements: `REVOKE ALL ... FROM PUBLIC` does
  **not** remove a role's separate, earlier *explicit* grant — `anon` had
  one on this function from before the team-pool work (harmless on its
  own, since anon's `auth.uid()` is null) that combined with the new
  `SECURITY DEFINER` to let anyone pass an arbitrary user id and read
  their exact balance, until revoked from `anon` by name specifically.
- **An RLS `USING` policy allowing a role is not enough by itself — the role
  also needs the underlying table-level `GRANT`, and PostgREST checks the
  grant first.** Found live 2026-09-28 building `routines.html`: `anon` had
  every grant on `user_routines` (`INSERT`/`UPDATE`/`DELETE`/etc.) except
  `SELECT`, so the existing `routines_public_read` policy
  (`is_public = true`) 401'd for every logged-out request despite being
  correctly written — nothing before this had ever exercised that path
  signed-out (chat.html's in-app gallery always runs with a session). Check
  `information_schema.role_table_grants` for the actual role, not just
  `pg_policy`, when a public/anon-facing query 401s despite a policy that
  looks right. Separately: **a column-scoped `GRANT SELECT (col1, col2, ...)`
  must list every column the query touches anywhere — `WHERE` clauses and
  RLS `USING` expressions included, not just the output column list.**
  Granting only the columns actually `select()`ed from the client (leaving
  out a column referenced only in a filter, like `is_public` here) fails
  with `42501 permission denied`, not a clean 0-row result.
- **An `auth.uid() = p_user_id` ownership check inside a `SECURITY DEFINER`
  function breaks that function for its own internal service-role caller —
  `auth.uid()` is NULL for a service-role-authenticated PostgREST call (no
  per-user JWT, no `sub` claim), so the check always fails and raises,
  regardless of GRANTs.** Found live 2026-10-03 (`site-guardian` sweep):
  `get_credit_balance(uuid)` was hardened on 2026-10-02
  (`20261002205713_harden_get_credit_balance_and_lock_admin_tables.sql`) to
  add exactly this `auth.uid() IS DISTINCT FROM p_user_id AND NOT
  is_admin()` guard — correctly fixing a real arbitrary-balance-disclosure
  bug — but `chat`, `api-chat`, `run-agent-task`, and `run-routines` all call
  this same function via a `service_role` client (`supaAdmin.rpc(...)`), so
  every one of those calls started silently raising `Forbidden`. **Real
  production impact, confirmed live with a throwaway account forced to
  -9801 credits: a chat message still succeeded and billed another credit**
  — because the destructured `const { data: balance } = await
  supaAdmin.rpc(...)` pattern (used at both the pre-send gate and the
  post-send balance report, in all four functions) discards the RPC's
  `error` entirely, so the exception became `balance: null`, and `typeof
  null === 'number'` is `false` — the `balance <= 0` no-credits gate never
  fired, and the live balance shown after every message was always `null`
  instead of a real number. Fixed by adding an explicit `auth.role() =
  'service_role'` bypass ahead of the ownership check
  (`20261003135208_fix_get_credit_balance_service_role_bypass.sql`) — safe
  because `EXECUTE` on this overload is already `GRANT`-restricted to
  `service_role` only (confirmed via `has_function_privilege`:
  `authenticated`/`anon` both `false`), so this doesn't expose anything new
  to a client, it just un-breaks the function's one legitimate internal
  caller. Verified live: the same -9801-balance account now correctly gets
  `402 {"error":"No credits","balance":0}`, and a positive-balance account
  gets a real `balance` integer in the response instead of `null`. **The
  general lesson: when a `SECURITY DEFINER` RPC is meant to be called both
  by a real user (their own JWT) and internally by an edge function's
  admin/service-role client, an ownership check written as `auth.uid() =
  p_user_id` needs an explicit `auth.role() = 'service_role'` escape hatch
  — GRANT-level restriction and an internal identity check are not the same
  thing, and adding the second without accounting for the first's only
  non-human caller silently breaks it.** Also found in the same sweep: this
  2026-10-02 migration had been applied live but never committed to the
  repo — pulled in now, see `supabase/migrations/`.
- **`newsletter_issues`** (`id, slug, title, summary, body, is_premium,
  published_at`) and **`pack_content`** (`pack_key, title, summary,
  price_cents, is_free, content`) are real, migration-backed tables (RLS:
  free rows open to `anon`+`authenticated`, premium/owned rows gated via
  `subscriptions`/`purchases`) wired to `send-newsletter` and
  `app/newsletter.html` — just never documented here until this sweep found
  them via an unfamiliar `get_advisors` finding. Not a bug; `pack_content`'s
  "owned" policy references the decommissioned `purchases`/`subscriptions`
  tables (see "Decommissioned: old per-plan subscription model" below) and
  is effectively dead code for the same reason those are, but harmless.
- **`deploy_edge_function`'s `verify_jwt` parameter defaults to `true` when
  omitted — it is not "leave as whatever the function already has," it's a
  real overwrite.** Found live 2026-10-05 redeploying `send-low-credit-email`
  (a function that's deliberately `verify_jwt: false`, since it
  authenticates callers via its own `X-Internal-Key` header check, not a
  Supabase session JWT): a deploy call that omitted the param silently
  flipped the live gateway setting to `true`, which would have 401'd
  `chat`'s fire-and-forget internal call before the function's own code
  ever ran. Caught immediately via the deploy call's own response (which
  echoes the function's current config), fixed with an explicit
  `verify_jwt: false` redeploy. **Always pass `verify_jwt` explicitly on
  every redeploy of an already-`verify_jwt: false` function** — check
  `get_edge_function` or `list_edge_functions` for the current value
  first if unsure, don't rely on the param being additive/optional.

## Pending / not yet applied

~~- Four pages (`/marketplace/`, `/builder/`, `/community/`,
  `/contractors.html`) were live/indexed but pitched a different, pre-pivot
  product~~ — **confirmed pre-"Aethyro Cloud" via git history and removed
  2026-09-28**, see "Decommissioned: pre-Cloud 'AI Operating Platform'
  pages" below.
~~- `app/community.html` was a fully-built but completely orphaned in-app
  forum~~ — **confirmed same pre-Cloud era and removed 2026-09-28**, see
  the same section below.

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

## Decommissioned: pre-Cloud "AI Operating Platform" pages (2026-09-28)

A `site-guardian` sweep on 2026-09-28 found four live, `sitemap.xml`-indexed
pages plus one orphaned in-app feature, all pitching a product with no
resemblance to the current Aethyro Cloud app. Confirmed via git history
they predate the pivot, then removed on explicit instruction after
presenting that evidence:

- `git log --diff-filter=A` on `marketplace/index.html`, `builder/index.html`,
  and `community/index.html` all point to the **same commit, 2026-06-01**:
  *"Launch AI Operating Platform — marketplace, builder, community pages."*
  `contractors.html` followed six days later, 2026-06-07. **Aethyro Cloud**
  (the current product — `app/chat.html`, browser chat, credit-pack billing)
  didn't launch until **2026-09-20**, ~3.5 months after these pages — a
  separate, earlier pivot ("AI Operating Platform": a local AI-agent
  builder + a per-vertical marketplace selling "Aethyro Legal"/"Aethyro
  CPA"/etc. at $29–79/mo, plus a standalone contractor-invoicing product
  at $99/mo — all local-hardware/Ollama-integrated, nothing like Cloud's
  one-time credit packs) that was simply never cleaned up when the product
  changed direction.
- `app/community.html` (a fully-built members-only forum — threads, posts,
  replies, reports, delete) is from the same era, added 2026-05-31 — one
  day *before* the other three — and its own commit message says
  *"+ dashboard link"*, meaning it really was wired into the dashboard
  originally. That link was later repointed to a Discord invite
  (`https://discord.gg/5PwBk8RVHv`) during the Cloud pivot; the forum's
  code and tables were left in place, unreferenced, rather than removed
  alongside the link change.
- Confirmed safe to remove before doing so: none of the 5 pages had a
  working automated purchase/signup flow (`marketplace/`'s "Start Trial"
  buttons were `mailto:` links; `contractors.html`'s waitlist form posted
  to `/site/email/signup`, which returns a live `405` — that endpoint was
  never actually implemented, so the form never worked and captured zero
  real leads); no `waitlist`/`email_signup`/`lead`-named table exists in
  the DB at all; `forum_threads`/`forum_posts` both had 0 rows, ever; and
  a repo-wide grep found nothing else anywhere referencing any of the 5
  paths except `sitemap.xml` itself.
- **Removed**: `marketplace/index.html`, `builder/index.html`,
  `community/index.html`, `contractors.html`, `app/community.html` (all
  deleted, along with their now-empty `marketplace/`/`builder/`/`community/`
  directories), their 4 corresponding `<url>` entries in `sitemap.xml`, and
  the forum's backing schema (`forum_threads`, `forum_posts`,
  `forum_reports`, plus the 3 trigger functions that only existed to serve
  them: `forum_after_post()`, `forum_rate_post()`, `forum_rate_thread()`)
  — migration `20260928030000_drop_orphaned_forum_schema.sql`. Nothing
  else in the repo referenced any of this, confirmed by grep before
  deleting. `dashboard.html`'s `[data-community]` Discord link needed no
  change — it was already correct.

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
~~- Not yet checked: `marketplace/`, `contractors.html`, `app/community.html`
  content for other stale references to the old model~~ — **checked
  2026-09-28: turned out to be a different, earlier decommissioned era
  entirely** (pre-dates even this subscription model), removed. See
  "Decommissioned: pre-Cloud 'AI Operating Platform' pages" above.

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

- **2026-10-06** — **Visual polish pass, part 3: `developers.html`,
  `routines.html`, `trust.html`** (`atlas-web-design`, continuing PRs
  #132/#133 — user asked to "do developers.html, routines.html, and
  trust.html next"). Audited all three before touching anything, and this
  pass split differently than the first two: `developers.html` (API docs)
  and `routines.html` (public gallery of user-submitted routine cards)
  had **zero emoji and zero icon usage at all**, not a drift case — a
  real, restrained scope call, not an oversight. API docs conventionally
  stay text/table-focused (Stripe's and GitHub's docs don't iconify every
  section either), and routine cards are user-generated content with no
  natural per-card icon mapping. Decorating either with invented icons
  would have been the exact over-design `atlas-web-design`'s restraint
  principle warns against — neither got icon treatment. The one real,
  genuine gap on both: no `grad-orange` headline span, while every other
  marketing/docs page on the site (homepage, pricing, blog) uses it for
  brand-consistent emphasis. Added `.grad-orange` CSS + a headline
  `<span>` wrap to both (`developers.html`: "One API key." / "Every
  model."; `routines.html`: "Routines people" / "built. Fork one.").
  `trust.html` was the one page in this batch that actually needed icon
  work — it already uses an icon-per-section convention (6 emoji-prefixed
  `<h2>`s: 🗑️🔒💳🧠🏗️📬), the same pattern PRs #132/#133 already fixed
  elsewhere. Replaced all 6 with the established 24×24 outline-SVG system,
  reusing shapes directly where topically exact (lock for "Account &
  access security," credit-card for "Payments," brain for "What your
  conversations are used for") and designing three new icons for shapes
  that didn't exist yet (trash can for "Verifiable deletion," a simple
  gabled building for "Infrastructure," an envelope for "Found a
  problem?"). Each icon takes its color from the section's own semantic
  accent (green for security, cyan for payments, violet for the AI/brain
  section, gold for infrastructure, orange for the two brand-adjacent
  sections) rather than one flat color across all six, matching how the
  homepage/pricing bento cards already vary accent per card. Also added
  the same `.grad-orange` headline treatment ("What actually happens" /
  "to your data."). **Deliberately left alone**: the `✓`/`✗` characters
  in `trust.html`'s checklist and "what we don't do" box — these are
  pure CSS `::before` content on list items, the same accepted
  checkmark-as-semantic-marker convention already established for
  `pricing.html`'s comparison table in PR #133, not an icon gap calling
  for SVG replacement.
  **Verified via a local-served copy** (not production) with Playwright
  across all three pages at 1280×900 and 390×844: all 6 `trust.html`
  icons render crisp in their correct accent color with no clipping, the
  gradient headlines render correctly on all three pages, zero horizontal
  overflow at any combination (6/6 clean), zero real console errors, and
  all inline `<script>` blocks (`developers.html` ×1, `routines.html`
  ×2, `trust.html` ×1) still parse clean via `node --check`-equivalent
  syntax validation. Re-grepped all three files for emoji after editing —
  zero remain anywhere. `routines.html`'s local-served Supabase fetch
  correctly shows its loading state in this QA pass (the live Supabase
  call was deliberately blocked in the test harness to avoid this
  session's already-documented sandbox proxy TLS-interception artifact,
  not a page bug — the page's actual community-routines fetch logic is
  unchanged from what PR #98 already shipped and verified live).
  **Scope note**: pure CSS/markup changes, no JS logic touched on any of
  the three pages, no backend/migration/edge-function involvement.

- **2026-10-06** — **Visual polish pass, part 2: `pricing.html` and
  `blog/`** (`atlas-web-design`, continuing PR #132's homepage pass —
  user asked to "do pricing.html and blog next"). Same audit, same
  pattern found: `pricing.html` had 10 raw-emoji icon instances across
  the "Everything included" feature grid and the trust-signal strip
  (🎁🧠📄⚡⏰🔗🔒💳, same tell as the homepage before PR #132) — replaced
  all of them with the same hand-authored outline-icon system (reusing
  the exact icon shapes already built for the homepage's matching
  features — memory/docs/zap/routines/link/lock/credit-card — for visual
  consistency between the two pages, plus a new gift-box icon for
  "Referral Rewards"/"200 free credits"). Left the `✓`/`✗` comparison-
  table checkmarks alone — same accepted convention as the homepage's
  pricing-comparison table, not an icon gap.
  `blog/index.html` and the two actual posts had **zero emoji** already
  (not a false-clean — genuinely never used any), but a real, different
  gap: zero gradient-text treatment anywhere in the blog, while every
  other page on the site (homepage, pricing) leans on `grad-orange`/
  `grad-cyan` spans for headline emphasis — the blog looked like a
  flatter, slightly different product. Added `.grad-orange` to the blog
  index's h1 (`AI that actually` / `works for you.`) — deliberately
  **not** applied to the two individual article H1s, which stay plain:
  editorial post titles get restrained treatment, the hub/index page
  gets the marketing treatment, matching how most content sites
  (Stripe's blog, Vercel's blog) draw this line. Also added a small
  topic icon (shield-check / clock) to each post card on the blog index
  for visual distinction — there was no way to tell the two posts apart
  at a glance before, just two identical text blocks.
  **Found and fixed one real, if minor, inconsistency while auditing
  the individual posts**: the "How to Evaluate an AI Tool" post's
  red-flag/green-flag checklist (10 items) used 🚩/✅ emoji inside an
  already-semantic `.red`/`.green`/`.icon` wrapper structure — swapped
  for a matching outline alert-triangle/check-circle pair, same
  treatment as everything else fixed this pass, now the only page on
  the whole site with zero emoji-as-UI anywhere.
  **Verified via a local-served copy** (not production) with Playwright:
  screenshotted the pricing feature grid and trust strip, the blog
  index, and the fixed checklist, all at full resolution — every icon
  renders crisp and in its correct accent color; confirmed zero
  horizontal overflow at 390px on `pricing.html` and all 3 blog pages;
  confirmed all 4 pages' inline `<script>` blocks still parse clean
  (`node --check`); re-grepped all 4 files for emoji afterward — zero
  remaining anywhere except pricing's intentional `✓`/`✗` table marks.
  **Scope note**: `developers.html`, `routines.html`, `trust.html`, and
  `use-cases.html`/`claude-opus-alternative.html`/
  `ai-chat-for-developers.html` weren't audited this pass — not asked
  for, and each is a narrower, more technical page than the three
  marketing surfaces (homepage, pricing, blog) this two-part pass
  targeted; worth a similar emoji/imagery sweep if they come up next.
- **2026-10-06** — **Homepage visual polish pass** (`atlas-web-design`,
  user-requested: "make this site better... professional grade... instead
  of looking like it was built in a garage"). Scoped to `index.html` only
  per explicit user choice (homepage first, roll out to other marketing
  pages later) with custom-authored graphics, not stock photography (also
  explicit user choice — no licensing cost, and fits the "sovereign AI
  infrastructure" brand better than generic stock photos of people).
  Audited the live homepage first: zero `<img>` tags anywhere on the page
  — every bit of "iconography" was raw emoji (🔒💬💳⚡🧠📚🔁🔗🚀🌐💻📄✍️🎯🔢🗂️,
  ~20 instances across the bento cards, intelligence-layer cards,
  capability grid, and trust-signal row, plus another 12 in the ⌘K
  command palette), which is the single biggest "unpolished SaaS
  template" tell there is.
  **Replaced every one** with a hand-authored, consistent outline-icon
  system (feather-weight 1.6px stroke, 24×24 viewBox, `stroke="currentColor"`
  so each icon inherits its card's existing accent color — cyan/orange/
  violet/green/amber — with zero per-icon color overrides needed). New
  `.ic`/`.ic-md`/`.ic-sm` CSS sizing classes. The command-palette icons
  route through a small `icoSvg(pathData, filled)` JS helper (15×15,
  same stroke system) rather than literal emoji strings in the `COMMANDS`
  array.
  **Found and fixed two real bugs while auditing the page**, not just a
  skin pass: (1) the `#agentCanvas` orchestration-layer node graph (the
  "Not a chatbot. An orchestration layer." section's live canvas
  visualization — this page's one piece of real generative graphics) had
  satellite nodes orbiting outside the 320px-tall canvas at angles near
  straight-up/straight-down, visibly clipping the Integrations and
  Knowledge nodes at the top/bottom edge on every page load. Fixed by
  squashing the vertical component of the orbit to 0.6× (an elliptical
  orbit instead of circular), keeping the full horizontal spread for the
  wide aspect ratio while keeping every node + its glow + label inside
  the canvas bounds at every angle. (2) Two different `<section>`s both
  had `id="demo"` (invalid HTML — duplicate ids — and functionally broken:
  the ⌘K palette's "Intelligence Panel" entry and any other `href="#demo"`
  could only ever reach whichever one came first in the DOM). Renamed the
  second one (the "Everything you need, in one window" product-UI
  mockup) to `id="product-demo"` and repointed the one link that actually
  meant to reach it.
  **Verified via a local-served copy** (`python3 -m http.server`, not
  production — this is an uncommitted-until-PR change) with Playwright:
  screenshotted every modified section (bento cards, intelligence cards,
  capability grid, trust-signal row, the fixed orchestration canvas, the
  ⌘K palette) at 1440×900 and 390×844, confirmed all 5 orchestration-canvas
  nodes now render fully inside the canvas with no clipping, confirmed
  zero horizontal overflow on mobile, confirmed all 3 inline `<script>`
  blocks still parse clean (`node --check`), and re-grepped for emoji
  afterward — the only survivors are semantically-correct table
  checkmarks/×-marks in the pricing-comparison table (a real, intentional
  convention, not an icon gap) and two small in-context severity dots
  (🔴🟡) and one inline "⚡ Intelligence" badge inside the hand-coded
  product-UI mockup further down the page, which are deliberately
  screenshot-style simulated-product-chrome, not primary marketing icons,
  and were left alone.
  **Scope note, deliberately narrow**: this PR is the icon/bug-fix pass
  only. A hero-section ambient visual (the existing `.hero-orb` blur
  glows are decent but minimal) and extending this same treatment to
  `pricing.html`/`blog/` are natural next steps, not done here — kept
  this PR small and independently reviewable rather than bundling a
  bigger redesign into one diff.
- **2026-10-06** — **`site-guardian` sweep, user-requested. Swept clean —
  zero bugs found, nothing to fix.** Ran the full checklist against the
  state left by PRs #128/#129/#130 (credit-aware router cap, return-visit
  hook, purchase-moment instrumentation), all merged the same day.
  `get_advisors` (security+performance): no new finding beyond this
  project's existing accepted classes (the 4 zero-policy tables —
  `admin_users`/`app_secrets`/`model_router_centroids`/
  `rate_limit_counters` — GraphQL-exposure boilerplate, the 2 intentional
  anon-executable 0-arg functions, and leaked-password protection still
  off at the Auth-service level — still correctly explained by the Free
  plan, not a regression). `list_edge_functions` (28) vs.
  `supabase/functions/` (24 committed): zero drift — the 4-function gap is
  exactly the known diagnostic set (`test-admin-setup`,
  `test-voyage-probe`, `test-embed-probe`, `test-embed-batch`), all still
  correctly inert. `pg_trigger` on `auth.users` (4, all enabled) and
  `pg_cron.job` (now 6, including `run-due-routines` added by PR #129
  earlier the same day) both matched this file's documentation exactly —
  no drift. Hard security constraint re-grepped clean (zero
  `buy.stripe.com` matches). Live smoke test with two real throwaway
  accounts: signup produced exactly one `profiles`/`referral_codes`/
  `signup_bonus` row each, zero `subscriptions` rows (no regression of
  the old double-bonus bug); a real chat message on all three
  `MODEL_MAP` keys (haiku/sonnet/opus) succeeded with correct billing and
  a real signed generation receipt for each; referral redemption happy
  path (+100 both sides), duplicate (409), self-referral (400), and
  invalid code (404) all correct; `buy-credits` resolved to a real
  `checkout.stripe.com` URL, never a bare Stripe link; **the credit-aware
  router cap from PR #128 re-verified still live**: an account forced to
  a 60-credit balance (below the 100-credit floor) with `model:"auto"`
  on a textbook-heavy prompt correctly capped to `sonnet`, while the same
  account's explicit `model:"opus"` choice was correctly left
  uninterfered with; a real routine (`email_on_result:true`) triggered
  via `run-routines` correctly ran, billed `-1 reason:'routine'`,
  advanced `next_run_at`, and attempted the result-email send (the send
  itself hit Resend's already-documented, non-bug rejection of
  `@example.com` test addresses — same pattern this file has noted
  multiple times before, not investigated further for that reason).
  `chat.html`'s 3 inline `<script>` blocks all syntax-checked clean.
  Static pages (`/`, `/robots.txt`, `/sitemap.xml`, `/terms.html`,
  `/privacy.html`, `/trust.html`, `/developers.html`, `/routines.html`)
  all live, a real unknown path still 404s. The 4 decommissioned-plan
  stub functions (`create-checkout`/`activate-license`/
  `validate-license`/`customer-portal`) all still correctly inert (3 of
  4 gateway-401 due to `verify_jwt:true` before even reaching the stub
  body; `validate-license` is `verify_jwt:false` and reaches its stub
  directly, returning `410` — both are the expected, documented behavior
  per function, not drift). **Not completed this sweep, same as every
  prior attempt**: the edge-function error-rate log check — tried
  `function_edge_logs`, `edge_logs`, and `function_logs` again, all three
  still error or return a backend error on this project's log backend;
  this has now failed identically across at least 3 separate sweeps
  (2026-10-03, 2026-10-03, 2026-10-06) and is a standing tooling
  limitation, not something worth retrying again without a different
  approach. Cleaned up: deleted both throwaway accounts (and the one test
  routine via cascade — a direct `DELETE` on the routine row itself hit
  the same intermittently-flaky `execute_sql` DELETE quirk this file
  already documents, resolved by letting the account deletion cascade
  it instead), confirmed zero orphaned rows across
  `profiles`/`credit_ledger`/`referral_codes`/`referral_events`/
  `user_routines`/`auth.users`, `test-admin-setup` re-stubbed to 410 and
  confirmed via a live curl.
- **2026-10-06** — **Instrumented and redesigned the post-depletion purchase
  moment** (part 3 of the "go deep" strategy discussion — part 1 was #128,
  the credit-aware router cap; part 2 was #129, the return-visit hook).
  Before this, the moment right after a balance hit zero had **zero
  instrumentation of any kind** — every entry point (the topbar "Buy more"
  button, the low-balance warning link, the depleted-bar link, the inline
  402-response "Buy credits" button in a cut-off reply, the agentic-task
  insufficient-credits link) opened the exact same bare 4-pack grid modal,
  and nothing about any of it — open, pack click, checkout start, cancel,
  or completion — was ever tracked. The only signal this product had on
  its own $0-lifetime-revenue number was the raw absence of rows in
  `credit_ledger`; there was no way to tell whether people never saw a buy
  prompt, saw it and ignored it, or started checkout and dropped off.
  **Instrumentation added**: `openCreditModal` now takes a `surface`
  argument (`topbar` / `low_balance` / `depleted_bar` / `depleted_inline`
  / `buy_param`) and fires a real GA4 `buy_modal_open` event; `startCheckout`
  fires `checkout_started` with the pack and surface; `handlePurchaseReturn`
  fires `checkout_cancelled` and, for the first time ever, `checkout_completed`
  (with real `credits_added`) once the webhook-credited balance is actually
  polled and confirmed — the one event this product could never previously
  produce, since it only existed after Stripe redirects back. `lockForDepleted`
  itself now fires `credits_depleted`, so the top of the funnel is measured
  too, not just clicks.
  **The actual redesign**: the two surfaces that represent someone getting
  cut off *right now* (`depleted_bar`, the composer-area bar; `depleted_inline`,
  the inline 402/insufficient-credits buttons shown directly in a cut-off
  reply) render a contextual block built from this session's own real,
  already-computed usage — `sessionCostTotal`/`sessionMsgCount` from the
  runway-estimate feature (PR #128) — e.g. "You've used 47 credits across 6
  messages this session — the Starter pack is the smallest way to keep
  going right now," and visually highlight the Starter ($4/200cr) pack as
  the lowest-commitment option for someone who just hit a wall and may not
  yet know if they'll keep using the product. A casual `topbar`/`low_balance`
  open keeps the original plain framing — the contextual treatment is
  deliberately scoped to the moment of actually getting blocked, not every
  "buy credits" entry point. The context block only ever renders from real
  numbers already computed this session (never a predicted/fabricated
  pack recommendation) and is correctly suppressed entirely when
  `sessionMsgCount` is 0 (e.g. a depleted account's very next page load,
  before any message has been sent this session) — verified explicitly as
  its own case, not just assumed.
  **Verified via a modified local copy of `chat.html`** (temporary
  `window.__test_*` hooks exposing the otherwise IIFE-scoped
  `openCreditModal`/`lockForDepleted`/session-state setter, never
  committed) served locally and driven with Playwright against the
  pre-installed Chromium, since this is a pure client-side change with no
  backend round trip to verify against: confirmed the depleted surface
  shows the correct contextual copy and recommended-pack styling, a casual
  topbar open shows neither, the zero-messages-this-session case correctly
  suppresses the context block, zero horizontal overflow at both 1280×900
  and 390×844 (the pack grid's existing 2-column mobile breakpoint still
  applies), and zero new console errors (only the sandbox's pre-existing
  TLS-intercepting-proxy `ERR_CERT_AUTHORITY_INVALID` noise on external
  Google Fonts/GA requests, already documented elsewhere in this file as
  a non-bug).
  **Scope**: pure frontend, no migration, no edge function change — `buy-credits`
  and `stripe-webhook` are untouched, since the actual checkout mechanics
  were already correct; this closes the measurement and the one-moment
  design gap only.

- **2026-10-06** — **Added the return-visit hook (part 2 of the "go deep"
  strategy discussion) — and found a real, previously-undocumented P0 live
  while building it: scheduled routines had never actually run on their
  own schedule, ever, for any user.** `run-routines`'s own top-of-file
  comment claims "Invoked by pg_cron every 15 minutes" — but
  `select * from cron.job` live showed 5 active jobs, none targeting
  `run-routines`. This meant a routine could only ever execute via a
  manual "Run now" click, a webhook trigger, or a chain — never its own
  cron schedule, since the feature shipped. Confirmed directly: the one
  real routine in the product (the owner's own account, "Daily AI News",
  created 2026-09-25, schedule `0 9 * * 1-5`) had `last_run_at: null` —
  never run, 11 days after creation, despite being enabled the whole
  time. **Found via a live test that had a real, if harmless, side
  effect**: while confirming the gateway-auth theory below, a direct curl
  to `run-routines` with no body actually executed that real routine for
  the first time — 1 real credit billed to the owner's own account
  (`leer4030@gmail.com`), not a third party, so no remediation needed,
  but worth being upfront about: in hindsight this specific probe should
  have used a throwaway account like every other live check in this
  session did.
  **Fixed**: new pg_cron job `run-due-routines` (`*/15 * * * *`,
  migration `20261006020100_schedule_run_routines_cron.sql`) invoking
  `run-routines` with the anon key as `Authorization` — matching the
  pattern `drip-engagement`/`drip-reengagement` already use for
  `send-welcome-email`. Confirmed live via direct curl *before* writing
  the migration that the anon key (a validly-signed Supabase JWT, role
  `anon`) satisfies `run-routines`' `verify_jwt:true` gateway check on
  its own, and that inside the function's own code a JWT that's neither
  the literal service-role key nor a resolvable user session (which the
  anon key, having no session, never is) leaves `userFilter` null —
  i.e. "run all due routines", identical to a real service-role call.
  No service-role secret is embedded in the migration.
  **The actual return-visit hook**: routines ran completely silently
  before this — the only way to see a result was to open the app and
  look at the Routines tab, giving zero reason to come back. New
  `user_routines.email_on_result` column (migration
  `20261006020000_routine_email_on_result.sql`, owner-writable via the
  existing `routines_own` RLS policy, no new grants needed) and new
  `send-routine-result-email` function (same `X-Internal-Key` internal-
  auth pattern as `send-low-credit-email`) — `run-routines` (now v8)
  invokes it right after a successful run if the routine opted in,
  emailing a short preview of the result with a link back to
  `chat.html`. `chat.html` gained: a "📧 Email me when this runs"
  checkbox on the routine-creation form; a per-routine "📧 Email: on/off"
  toggle button on each routine card (same pattern as the existing
  Publish/Make-private toggle); and a one-click "📰 Try it: daily AI
  briefing →" quick-start in the empty-state feature-tryouts row
  (alongside the existing upload-document/create-routine tryouts from
  PR #124) that creates a pre-filled "Daily Briefing" routine
  (schedule `0 9 * * *`, haiku, `email_on_result: true`) with one click
  — no blank form — since the real hook is the email itself, not another
  tab to discover.
  **Verified live end-to-end**, not just code review: a real throwaway
  account's routine (`email_on_result: true`), triggered via the same
  `run-routines` call shape the "Run now" button and the new cron job
  both use (anon key as Authorization, no service-role secret needed),
  correctly ran, billed, advanced `next_run_at`, and fired the email —
  confirmed via Resend's own send log, which shows `Your "Return-Visit
  Test" is ready`, status `sent`, timestamped to the same second as the
  `run-routines` call. Both edge functions' live source fetched back via
  `get_edge_function` and confirmed byte-for-byte matching local disk.
  Syntax-checked `chat.html`'s modified inline scripts. Cleaned up:
  deleted the throwaway account, confirmed zero orphaned rows including
  `user_routines`, `test-admin-setup` re-stubbed to 410 and confirmed via
  a live curl.
  **What this does NOT fix, scoped deliberately narrow**: it doesn't add
  per-user timezones (the "9am" in both the quick-start and the existing
  cron-preset buttons is UTC, an existing, unchanged convention — not
  something this PR introduces or claims to fix), and it doesn't touch
  the still-open $0-revenue monetization gap from the same strategy
  discussion, which remains a separate, larger move.
- **2026-10-06** — **Added a credit-aware router cap, and a real-time "runway"
  estimate on the cost badge** — the first concrete move on a "what would
  make this product substantial" strategy discussion, grounded in a fresh
  pull of real usage data rather than a generic brainstorm: 30 total users
  (28 signed up in the last 7 days — a real, continuing growth spurt), **$0
  revenue ever**, only 63% of users ever opened a chat, and of those, **89%
  never returned on a second day**. The same pull showed 82% of all billed
  messages were Opus (the most expensive model, 7.5cr/1k output tokens)
  against a one-time 200-credit free grant — `model:"auto"`'s classifier
  (`classifyModelFromEmbedding`) had zero awareness of the caller's credit
  balance, so a brand-new account could burn its entire free grant on a
  handful of auto-routed Opus replies before ever discovering anything else
  the product does.
  **Server-side fix** (`chat` now v47): a new `AUTO_MODEL_CREDIT_FLOOR = 100`
  constant (half the free signup grant) — once a user's balance drops below
  it, `model:"auto"` stops resolving to Opus and tops out at Sonnet instead.
  Only affects the `auto` path; an explicit `model:"opus"` choice is never
  overridden, preserving user autonomy even at a low balance.
  **Client-side addition**: the existing per-message cost-transparency badge
  gained a real-time "~N more at this rate" estimate next to the balance
  pill, computed from this session's own actual average cost-per-message
  (`sessionCostTotal / sessionMsgCount`) — never a guess or a fixed
  per-model number, and deliberately hidden until at least one message has
  actually been billed this session, so no estimate ever beats a fabricated
  one. This is additive to the existing worst-case `lowBalance` warning
  banner (which already showed "an Opus reply can cost up to ~80 credits"),
  giving users an always-visible, continuously-updating sense of the wall
  coming instead of only a warning once they're already close to it.
  **Verified live end-to-end** with a real throwaway account across four
  scenarios, not just code review: balance 60 (below the floor) + a
  textbook "heavy" prompt (security audit, prove, root cause) → **capped
  to sonnet** (2 credits, confirmed via the real signed generation receipt
  this message produced); balance 150 (above the floor) + the same kind of
  heavy prompt → **opus**, uncapped (10 credits) — proving the cap is
  balance-conditional, not a global regression; balance 150 + a trivial
  "thanks!" → **haiku**, unaffected; balance 50 (well below the floor) +
  **explicit** `model:"opus"` → **opus**, confirming an explicit choice is
  never silently downgraded. `chat`'s live source fetched back via
  `get_edge_function` and confirmed byte-for-byte matching local disk
  before trusting the deploy. Cleaned up: deleted the throwaway account,
  confirmed zero orphaned rows across `profiles`/`credit_ledger`/
  `conversations`/`generation_receipts`, `test-admin-setup` re-stubbed to
  410 and confirmed via a live curl.
  **What this does NOT fix, by design, scoped deliberately narrow**: it
  doesn't touch the $0-revenue monetization gap or build a return-visit
  hook — both flagged in the same strategy discussion as separate, larger
  moves worth their own PRs, not bundled into this one.
- **2026-10-05** — **Added signed generation receipts** — the counterpart to
  the existing deletion receipts, for the same reason: let a user hold a
  tamper-evident, independently-verifiable record of what Aethyro actually
  did, instead of asking them to trust a screenshot or the chat UI. Every
  billed chat reply now gets an HMAC-SHA256-signed receipt recording the
  model, exact token counts, cost, and what context fed into it (tool
  calls, memory/document retrieval counts) — assembled and signed
  server-side in `chat`'s `finalize()` right after billing, using data the
  edge function itself just computed, never anything a client supplies.
  New `generation_receipts` table (own HMAC key,
  `generation_receipt_hmac_key`, separate from `deletion_receipt_hmac_key`
  so rotating one can never invalidate the other) plus two RPCs mirroring
  the existing `delete_conversation_with_receipt`/`verify_deletion_receipt`
  pattern exactly: `create_generation_receipt(...)` (service-role-only,
  checks `auth.role() = 'service_role'` directly rather than any
  `auth.uid()` branch — same lesson this file already has multiple times
  for a function with exactly one legitimate internal caller) and
  `verify_generation_receipt(uuid)` (authenticated, owner-scoped,
  recomputes the signature server-side so nothing secret ever leaves the
  database). `chat.html`'s per-message cost badge gained a "📜 Receipt"
  button (only shown when a receipt came back) opening a modal — payload,
  signature, a Verify button, a JSON download — that's a near-exact mirror
  of the existing deletion-receipt modal, new ids throughout. Migrations:
  `20261006000000_generation_receipts.sql`,
  `20261006000100_lock_down_receipts_table_grants.sql`. `chat` now at v46.
  **Found and fixed a previously-undocumented bug on the *existing*
  deletion-receipts feature while building this**: `deletion_receipts`
  (shipped 2026-09-27) had never actually been locked down — it had the
  same default-privileges over-grant this file already documents multiple
  times (full `ALL`-privilege access to `anon`/`authenticated`), missed by
  every prior site-guardian sweep since. Not currently exploitable (RLS
  denies any command with no matching policy, and the table's one SELECT
  policy is unreachable for `anon` since `auth.uid()` is null for that
  role), and `chat.html` never queries either receipts table directly —
  both are only ever read/written through their `SECURITY DEFINER` RPCs,
  whose function owner (`postgres`) bypasses table grants entirely
  regardless of what's revoked from `anon`/`authenticated` — but fixed in
  the same migration as the new table's lockdown, for consistency with
  this project's "always lock down" discipline. Confirmed via direct SQL
  that both RPCs' owner (`postgres`) retains full table access after the
  revoke, so the existing deletion-receipt flow is provably unaffected —
  a live re-test of that flow was attempted but blocked by a transient
  `esm.sh`/`deno.land` dependency-fetch timeout repeatedly bundling the
  diagnostic helper (not a real bug; same class of sandbox network
  flakiness this file already notes elsewhere), so this is verified by
  mechanism (ownership + bypass) rather than a fresh end-to-end run.
  **Verified live end-to-end for the new feature**, not just code review:
  a real throwaway account's real `chat` message (Haiku) returned a real
  `receipt` object with a genuine `receipt_id`/`payload`/`signature`; the
  row existed in `generation_receipts` with matching data;
  `verify_generation_receipt` correctly returned `valid: true` against it
  (first attempt via direct curl 404'd on `api.verify_generation_receipt`
  — a schema-cache/`Content-Profile` header artifact of calling PostgREST
  directly rather than through `supabase-js`, which sends the right
  header automatically and was never actually broken; resolved by adding
  `Content-Profile: public` to the test curl, not a real bug). Cleaned up:
  deleted the throwaway account, confirmed zero orphaned rows across
  `profiles`/`credit_ledger`/`conversations`/`generation_receipts`/
  `deletion_receipts`, `test-admin-setup` re-stubbed to 410 and confirmed
  via a live curl (401, matching the established stub pattern).
- **2026-10-05** — **Fixed: `send-welcome-email`'s day-5 "reengagement"
  email's own targeting gate was silently broken, sending to every
  candidate regardless of real usage.** Found while investigating a
  retention pattern pulled live: of 20 accounts old enough to have a
  "day 2", only 1 has ever returned and sent a message on a day other
  than their signup day — the rest engaged once (if at all) and never
  came back, which is the real story behind this product's $0 lifetime
  revenue. The existing day-2/day-5 drip cron jobs (`drip-engagement`/
  `drip-reengagement`) are correctly wired and firing on schedule — not
  a bug — but the day-5 email is supposed to only go to users who've
  sent **zero** real messages (so an already-active user never gets
  told their credits are "still waiting"), and its gate queried
  `messages.user_id` — a column that, per this file's own schema
  gotchas, doesn't exist. The query errors, the code destructures only
  `{ count }` and discards the error, and `(count || 0) === 0` ends up
  permanently `true` — meaning this gate has always passed
  unconditionally, for every candidate, engaged or not. It hadn't
  visibly misfired yet purely by luck: every real day-5 candidate so
  far also happened to have zero messages. Fixed by scoping through
  `conversations` like every other per-user `messages` query in this
  codebase (fetch the user's conversation ids, then count messages in
  those), and made it fail *closed* on an unexpected lookup error —
  skip the send rather than risk the wrong message reaching an active
  user. Checked `verify_jwt` before deploying (per the gotcha below from
  earlier the same day) — confirmed `false`, passed explicit. Live
  source fetched back and diffed byte-for-byte against local disk.
  **Verified live, not just logic review**: two real throwaway accounts,
  one given a real message via a direct DB insert, one left at zero —
  calling the reengagement check directly on both showed the fix
  correctly discriminating: the account with a message got a clean
  `{ok:true}` with *no* Resend call attempted (correctly skipped), while
  the zero-message account correctly proceeded to a real send attempt,
  which only then hit Resend's expected, already-documented rejection
  of `@example.com` test addresses — confirming the code path reached
  the real send for the right account and not the wrong one. Neither
  account picked up a stray `reengagement_sent_at`, consistent with both
  outcomes being correct. Cleaned up: both throwaway accounts deleted,
  zero orphaned rows confirmed, `test-admin-setup` re-stubbed to 410 and
  confirmed via a live curl.
- **2026-10-05** — **Fixed: a user who goes from a positive balance straight
  to 0/negative in a single message got zero credit notification of any
  kind, ever.** Pulled real revenue data after PR #124: **$0 in purchases,
  ever**, across this product's entire lifetime, despite 27 real signups —
  and 1 real account sitting at a real **-34 credits** since 2026-10-01
  with `low_credit_warned_at` still `null`. Root-caused in
  `supabase/functions/chat/index.ts`'s `finalize()`: the low-credit-email
  trigger is `newBal > 0 && newBal <= 30` — it only fires if the balance
  lands *inside* the 1-30 window. A single large Opus reply (the same
  account's own story from PR #122) can jump straight from, say, 47 to -34
  in one message, skipping that window entirely; the only thing that
  fires for `newBal <= 0` is the pre-send 402 gate on the *next* attempt,
  which only helps if the user is still looking at the tab. Added a
  sibling `else if (newBal <= 0)` branch that fires `send-low-credit-email`
  with a new `depleted: true` flag, gated by its own new
  `profiles.credits_depleted_warned_at` 24h pre-check (mirrors the
  existing `low_credit_warned_at` check) so it never competes with the
  warning email's cooldown — migration
  `20261005160000_profiles_credits_depleted_warned_at.sql`.
  `send-low-credit-email` (now v6) branches its own subject/copy
  ("Your Aethyro credits ran out" vs. the existing "You have N credits
  left") and its own 7-day cooldown column (`credits_depleted_warned_at`
  vs. `low_credit_warned_at`) on the same `depleted` flag. **Caught and
  fixed my own deploy mistake before it shipped**: the first
  `send-low-credit-email` deploy omitted `verify_jwt` and the tool
  defaulted it to `true`, silently flipping this function's gateway
  setting from its correct `false` (it authenticates via its own
  `X-Internal-Key` check, not a Supabase JWT) — would have broken its one
  real caller (`chat`'s fire-and-forget internal invoke). Caught via
  the deploy response itself (not assumed), redeployed immediately with
  `verify_jwt: false` explicit. Both functions' live source fetched back
  via `get_edge_function` and diffed byte-for-byte against local disk
  before trusting either deploy, per this file's own established
  discipline. **Verified live end-to-end, not just logic review**: a real
  throwaway account (temporary `test-admin-setup` redeploy, same
  established pattern) forced to a 1-credit balance, sent a real `chat`
  message — balance landed at exactly 0, the new branch fired (confirmed
  via `credits_depleted_warned_at` going from `null` to a real timestamp,
  `low_credit_warned_at` staying `null` — the *right* branch fired, not
  the old one), and a second depleting message sent immediately after
  confirmed the 24h cooldown correctly suppressed a second trigger
  (`credits_depleted_warned_at` unchanged). Direct confirmation of the
  Resend send itself wasn't available this run (`function_edge_logs`/
  `function_logs` both returned backend errors on every attempt, a
  worse version of this file's already-documented log-table-naming
  quirk) — the DB-state evidence is enough: `supaAdmin.functions.invoke()`
  not throwing before the column update proves the call reached
  `send-low-credit-email` and got a response, and this repo's own history
  already established that `@example.com` throwaway addresses get a
  clean Resend rejection, not a bug, so a bounce there wouldn't prove
  anything a real address wouldn't. **One real, known limitation, not
  silently papered over**: this fix only helps a user who crosses from
  positive to negative *during a chat completion that finishes* — the
  real depleted account found this sweep (still at -34) is already
  blocked by the pre-send 402 gate and can't send another message to
  ever trigger this new branch themselves; it only protects future users
  going forward, not that one retroactively. Cleaned up: deleted the
  throwaway account, confirmed zero orphaned rows across
  `profiles`/`credit_ledger`/`conversations`, `test-admin-setup`
  re-stubbed to 410 and confirmed via a live curl.
- **2026-10-05** — **Added a post-first-reply discoverability nudge** (PR
  #124), prompted by real usage data pulled the same day rather than a
  generic brainstorm: a real growth event is underway (25 of 27 total
  accounts signed up in the last 7 days, spiking right after this
  project's LinkedIn post), but activation is leaky — 8 of those 25
  (32%) never opened a chat at all, and of the 17 who did, most sent
  1-2 messages and left; 0 document uploads and only 1 routine ever
  created in that window despite both being fully built features. PR
  #123 (2026-10-05, merged same day) already added "try it" buttons for
  these, but only in the empty state — before a first message — which
  is exactly the moment *before* most of this drop-off happens. This PR
  adds a second, complementary touchpoint: after a signed-in user's
  first fully-completed assistant reply (inside `send()`'s existing
  `if(full){...}` block, right after the cost-transparency badge),
  `app/chat.html` shows a small dismissible banner above the composer —
  "Aethyro can also read your documents or run this on a schedule" —
  gated on a one-time `localStorage` flag (`aethyro_post_reply_nudge_v1`)
  so it shows once ever per browser, never again after being dismissed
  or clicked. Its two action buttons and the empty-state's original
  `#tryUploadDoc`/`#tryRoutine` buttons both now call shared
  `openDocUploadFlow()`/`openRoutineFlow()` functions (refactored out of
  PR #123's inline handlers) — **necessary, not just cleanup**:
  `startNewChat()` rebuilds `#emptyState` via `innerHTML` without the
  `#featureTryouts` buttons at all, so a nudge that tried to
  `.click()`-forward to those buttons would silently no-op for any user
  who'd clicked "New chat" first. Frontend-only, no migration, no edge
  function change. Verified headless (not live-account, matching this
  repo's established bar for a change this size and this close in shape
  to the already-verified PR #123): JS syntax-checked, default state
  hidden, reveals at the correct size with zero horizontal overflow at
  both 1280×900 and 390×844, dismiss button correctly hides it, and
  clicking either action button with no real session correctly shows
  the existing "Sign in to use Intelligence features" toast rather than
  erroring (same guard `openIntelPanel()` already had).
- **2026-10-03** — **`site-guardian` sweep, user-requested.** One real
  finding, fixed and verified live; everything else checked clean.
  **Fixed**: `cleanup_old_rate_limit_counters()` — added by the same-day
  `20261003160000_rate_limit_counters.sql` migration alongside
  `increment_rate_limit()` — had no `REVOKE`/`GRANT` statements at all,
  unlike its sibling function in the same migration (which correctly
  locks `EXECUTE` to `service_role`). Confirmed live via
  `has_function_privilege` before fixing: both `anon` and `authenticated`
  could call it directly via `/rest/v1/rpc/cleanup_old_rate_limit_counters`.
  Same recurring bug class this file already documents multiple times
  (`classify_router_tier`, the `api_keys` table grant, `get_credit_balance`)
  — a new function's default grant here is a floor, not a ceiling, unless
  explicitly revoked. Practical severity was low (it only deletes
  `rate_limit_counters` rows older than 1 hour, which can't affect the
  *current* minute's rate-limit window), but it defeated the migration's
  own stated design ("the only legitimate caller is each edge function's
  own `supaAdmin` client... SECURITY DEFINER + service_role-only by
  design") and is exactly the drift class this skill exists to catch.
  Fixed with `20261003210000_lock_down_cleanup_rate_limit_counters.sql`
  (`REVOKE ALL ... FROM PUBLIC, anon, authenticated`, explicit `GRANT` to
  `service_role`/`postgres`). The function's one real caller — the
  `cleanup-rate-limit-counters-hourly` pg_cron job — is unaffected, since
  it runs as a superuser role that bypasses GRANT checks entirely (same
  reasoning already applied to `trigger_welcome_email()`'s equivalent
  lockdown). Verified live: `has_function_privilege` now shows
  `anon`/`authenticated` both `false`, and a direct anon curl to the RPC
  endpoint now correctly `404`s instead of `200`ing.
  **Everything else checked clean**: `get_advisors` (security+performance)
  — no other new finding beyond this one and the project's existing
  accepted classes (zero-policy tables — now 4, `model_router_centroids`/
  `rate_limit_counters` added to the existing `admin_users`/`app_secrets`
  pattern, all intentional; GraphQL-exposure boilerplate; the two
  pre-existing intentional anon-executable 0-arg functions,
  `get_credit_balance()`/`is_admin()`); `list_edge_functions` (27 total)
  vs. `supabase/functions/` (24 committed) — the 3-function gap is exactly
  the known diagnostic set (`test-admin-setup`, `test-voyage-probe`,
  `test-embed-probe`, `test-embed-batch` — that's actually 4, all
  confirmed still correctly stubbed to inert `410`/`410`-equivalent
  responses, no drift); `pg_trigger` on `auth.users` (exact match, all 4
  enabled) and `pg_cron.job` (5 jobs, matching — the 5th,
  `cleanup-rate-limit-counters-hourly`, was added the same day as this
  sweep and is already documented above) both clean; 24h edge-function
  error sweep (`function_edge_logs`, correct field is
  `log_attributes['response.status_code']` — `response_status` and a bare
  `metadata` column both errored, worth remembering for next time) found
  nothing but this session's own deliberate test traffic (429s from the
  rate-limit load test, 402s from the forced-negative-balance test, 401s/
  410 from `test-admin-setup` probing) plus 3 `send-welcome-email` 500s —
  traced via `function_logs` to Resend correctly refusing
  `to: *@example.com` (this session's own throwaway test accounts), the
  exact same non-bug this file already documented from the 2026-09-30
  sweep; hard security constraint re-grepped clean (zero `buy.stripe.com`
  matches); static pages (`/`, `/robots.txt`, `/sitemap.xml`,
  `/terms.html`, `/privacy.html`, `/trust.html`, `/developers.html`,
  `/routines.html`) all live, a real unknown path still 404s; the
  `create-checkout` decommission stub re-checked, still correctly 410.
  **Not re-tested this sweep** (no code changed in either since their
  last same-day verification, and this sweep's one real finding was
  unrelated to both): a full throwaway-account signup/chat/referral smoke
  test, and the `buy-credits` real-Stripe-URL check — both were exercised
  multiple times earlier today across the rate-limiting and audit-rerun
  work; re-running them again this sweep would have been redundant
  rather than additive.
- **2026-10-03** — **Acted on two gaps from an external landing-page review**
  (PR #118): a trust-claim/proof-link gap and a pricing-transparency gap.
  The review itself rated the homepage 8.5/10 and flagged four things;
  two were already handled before the review landed (fabricated
  testimonials removed 2026-09-28, not re-added — no real customers to
  quote yet; `/trust.html` already existed, just under-linked) and one
  (visual emphasis on the agent-orchestration section) is a design call,
  not a correctness fix, left alone. The two real, actionable gaps:
  (1) the hero's "your data never sold" badge and the "Why Aethyro"
  data-sold bento card both made trust claims with no nearby link to the
  page that actually substantiates them — `trust.html` was linked only
  from the footer. Added inline `trust.html` links at both claim sites.
  (2) `#pricing` explained the credit model conceptually only, with no
  worked example of what a task actually costs. Added a "what a task
  actually costs" panel with three example costs (quick question /
  explain-summarize / deep review, on Haiku/Sonnet/Opus respectively) —
  the dollar figures are derived from `developers.html`'s already-published
  `CREDIT_RATES` (Haiku 0.08/0.40, Sonnet 0.30/1.50, Opus 1.50/7.50
  credits per 1k tokens) and the real Starter pack price ($4/200
  credits), not invented numbers, and explicitly labeled as approximate.
  Verified via headless Chromium at 1280×900 and 390×844: zero console
  errors, zero horizontal overflow at either width, both new links and
  the new panel render correctly.
- **2026-10-03** — **Fixed the 2 remaining gaps from the pro-grade audit
  re-run the same day: apple-touch-icon correctness and per-user/per-key
  rate limiting on `chat` and `api-chat`.**
  **Apple-touch-icon**: the existing tag pointed at `favicon.svg` on only
  12 of 24 pages — iOS Safari doesn't accept SVG for home-screen icons at
  all, so this was never actually working despite looking present.
  Rasterized a real 180×180 PNG from the same SVG via headless Chromium
  (no `cairosvg`/`Pillow`/`sharp` available in this sandbox; Playwright +
  the pre-installed Chromium was the reliable path) — first attempt baked
  in the SVG's own rounded corners against a white page background,
  leaving visible white corners in the PNG; fixed by flattening to a full
  bleed square (`rx="0"`, matching background) and letting iOS apply its
  own corner mask, which is the standard convention. Added
  `/apple-touch-icon.png` at the repo root and corrected or added the
  `<link rel="apple-touch-icon">` tag on **all 24** HTML pages — 12 had
  the wrong `href`, 11 were missing the tag entirely, and `app/admin.html`
  had no favicon tags *or* the required `noindex,nofollow` robots meta at
  all (added both while fixing this, since the page is otherwise
  identical in kind to every other `app/*.html` page).
  **Rate limiting**: new `rate_limit_counters` table + `increment_rate_limit()`
  RPC (migration `20261003160000_rate_limit_counters.sql`), a generalized
  version of the existing `trial_usage`/`increment_trial_usage` fixed-window
  pattern with a `key_type` column so one table serves both `chat`
  (`chat_user` + `user.id`, 20 req/min) and `api-chat` (`api_key` +
  `api_keys.id`, 30 req/min) instead of duplicating it. `SECURITY DEFINER`
  + a strict `auth.role() <> 'service_role'` check with **no** `OR
  auth.uid() = ...` branch — unlike `get_credit_balance`, this function's
  only ever legitimate caller is each edge function's own `supaAdmin`
  client, never a per-user JWT, so there's no second case to get wrong
  here (see this file's own `get_credit_balance` incident from earlier
  today for exactly what happens when that distinction is missed). An
  hourly `pg_cron` job (`cleanup-rate-limit-counters-hourly`) prunes rows
  over 1 hour old, same shape as the existing daily trial-usage cleanup.
  Both edge functions check-and-increment right after auth resolution,
  before any expensive work (JSON parsing, the credit check, the Anthropic
  call) — and fail *open* (log, let the request through) if the RPC call
  itself errors, so an infra hiccup degrades to "no rate limit" rather
  than blocking real traffic. **Verified live with real concurrent load**,
  not just code review: 25 parallel requests to `chat` from one throwaway
  account returned exactly 20× `200` and 5× `429`; 38 parallel requests to
  `api-chat` from one real API key returned exactly 30× `200` and 8×
  `429` — both precisely matching the configured limits, confirming the
  atomic upsert holds correctly under real concurrency.
  **Caught and fixed a real client-side bug while verifying this** — not
  theoretical, found by actually reading `chat.html`'s existing response
  handling rather than assuming a 429 was safe to ship: `send()` already
  had an `if(resp.status===429)` branch, but it was written only for the
  anonymous trial endpoint's daily cap and unconditionally called
  `lockForSignup()` — which sets `trialLocked=true` and permanently
  disables the input with "Sign up to keep chatting →", with **no
  corresponding unlock function**. Had this shipped as-is, any real
  signed-in user who tripped the new per-minute limit would have been
  told to sign up and had their chat input permanently disabled until a
  page reload. Fixed by branching on `session`: the existing trial-limit
  message + `lockForSignup()` only fires for the anonymous path;
  authenticated users instead see "You're sending messages a bit fast —
  please wait a moment and try again," with nothing locked (the existing
  `finally` block's `busy=false` already handles re-enabling the send
  button correctly once `trialLocked` isn't set).
  Updated `developers.html`'s "known v1 gaps" copy and its error-code
  table, which had explicitly and accurately documented the *absence* of
  rate limiting — leaving that stale after shipping the fix would have
  been its own correctness bug.
  Cleanup: deleted the throwaway account and its real API key (profiles/
  api_keys cascaded correctly); 2 leftover `rate_limit_counters` test rows
  could not be deleted directly — `execute_sql` DELETEs against this
  project intermittently return `{"status":"cancelled"}` while SELECTs on
  the same table succeed instantly (a known, previously-documented quirk
  of this backend, not specific to this table) — left in place rather
  than fought further, since they're harmless (zero grants to
  `anon`/`authenticated`, no sensitive data) and the new hourly cleanup
  cron purges them within the hour regardless. `test-admin-setup`
  re-stubbed to 410, confirmed via a live curl.
- **2026-10-03** — **Re-ran the pro-grade site audit** (the artifact this
  file links at the top), on request, rather than reusing the stale
  2026-09-27 score. Score moved from 72/100 to 91/100 — every figure
  re-verified live against the repo, the database, and the production
  site, not carried forward: 24 pages (was 13), 19 active edge functions
  (was 10, +8 intentionally stubbed), 29 DB tables all RLS-enabled (was
  an unverified "15+"), and 18 real profiles / 61 billed ledger rows to
  check against instead of the near-zero-signup state the original audit
  worked from. 12 of the original 16 gap items are now fixed; the
  remaining 5 (apple-touch-icon, rate limiting, CORS wildcard on `chat`/
  `buy-credits`, skeleton loading states, PWA offline) are listed in the
  audit itself with honest effort/priority estimates — the first two are
  closed by the entry directly above this one, the same day. Also
  corrected one stale claim in the process: the original "~8ms TTFB" was
  never actually measured; three real `curl` timing runs this time
  measured ~200ms (with the caveat that includes this session's own
  network path, not pure edge latency).
- **2026-10-03** — **`site-guardian` sweep, user-requested. Found and fixed
  one P0: the credit-balance gate on every billed surface in the app (chat,
  the public API, agent tasks, scheduled routines) was silently fail-open
  since 2026-10-02.** Full detail in the new schema-gotchas bullet above;
  summary here. Root cause: a same-day-prior migration
  (`20261002205713_harden_get_credit_balance_and_lock_admin_tables.sql`,
  applied live but never committed until this sweep pulled it in) correctly
  fixed a real arbitrary-balance-disclosure bug in
  `get_credit_balance(uuid)` by adding an `auth.uid() = p_user_id OR
  is_admin()` check — but that check has no awareness of the function's
  other legitimate caller: `chat`/`api-chat`/`run-agent-task`/`run-routines`
  all call it via a `service_role` client with no per-user JWT, so
  `auth.uid()` is NULL there and the check raised `Forbidden` on every
  single call, silently, because all four functions destructure just
  `{ data }` from the RPC call and never check `error`. **Proven live, not
  theoretical**: a throwaway test account forced to a real **-9801** credit
  balance still got a successful, billed chat reply. Fixed with
  `20261003135208_fix_get_credit_balance_service_role_bypass.sql` (adds an
  explicit `auth.role() = 'service_role'` bypass ahead of the ownership
  check — safe, since `EXECUTE` on this overload is already
  `service_role`-only by `GRANT`). Re-verified live: the same -9801-balance
  account now correctly gets `402 "No credits"`, and a positive-balance
  account gets a real `balance` integer in the chat response instead of the
  `null` it had been silently returning (meaning the live-updating balance
  pill in `chat.html` had also been silently stuck since 2026-10-02 — one
  fix resolves both).
  **Second, smaller finding, fixed in the same sweep**: `routine_webhooks`
  had the full default-privilege over-grant (`SELECT`/`INSERT`/`UPDATE`/
  `DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`) to both `anon` and
  `authenticated` — not currently exploitable (its RLS policy's join to
  `user_routines.user_id = auth.uid()` never matches for `anon`, whose
  `auth.uid()` is null), but matches this project's own recurring
  over-grant pattern and `anon` had zero legitimate reason to hold any of
  it. **Caught and corrected a mistake in my own fix before shipping it**:
  an initial `REVOKE ALL ... FROM authenticated` over-reached and also
  stripped `authenticated`'s legitimate `INSERT`/`DELETE` (needed for the
  real owner create/revoke-and-regenerate flow, confirmed via
  `information_schema.role_table_grants` immediately after the first
  revoke, before any PR) — corrected in the same pass
  (`20261003135352_lock_down_routine_webhooks_grants.sql` reflects the
  final, correct state directly: `anon` gets nothing, `authenticated` keeps
  `SELECT`/`INSERT`/`DELETE`, loses `UPDATE`/`TRUNCATE`/`REFERENCES`/
  `TRIGGER`). Verified end-to-end with a real throwaway account: owner
  INSERT/SELECT/DELETE on their own webhook all still succeed, `anon`
  INSERT/SELECT both now correctly `401` at the grant level (previously a
  silent 0-row RLS block).
  **Also found, not a bug**: two real, migration-backed tables
  (`newsletter_issues`, `pack_content`) had never been documented in this
  file's schema-gotchas section — added above. Three stray diagnostic edge
  functions (`test-voyage-probe`, `test-embed-probe`, `test-embed-batch`,
  none committed to the repo) were all confirmed already correctly stubbed
  to inert `410` responses from prior sessions — no drift. `pg_trigger` on
  `auth.users` and the 4 live `pg_cron` jobs both matched this file's
  existing documentation exactly. Static pages
  (`/`, `/robots.txt`, `/sitemap.xml`, `/terms.html`, `/privacy.html`,
  `/trust.html`, `/developers.html`, `/routines.html`) all live and
  correct; a real unknown path still 404s. Hard security constraint
  re-grepped clean (zero `buy.stripe.com` matches). Signup smoke test
  clean: exactly one `profiles`/`referral_codes`/`signup_bonus` row, zero
  `subscriptions` rows (no regression of the old double-bonus bug).
  **Not completed this sweep**: the edge-function error-rate log check
  (`query_logs`) — tried `function_edge_logs`, `edge_logs`, and
  `function_logs` as table names and none resolved against this project's
  log backend this run; flagged here rather than silently skipped, worth
  retrying with the correct table name next sweep. Cleaned up: deleted the
  throwaway test account and its test routine (zero orphaned rows
  confirmed across `profiles`/`credit_ledger`/`user_routines`/
  `referral_codes`/`conversations`), `test-admin-setup` re-stubbed to 410
  and confirmed via a live curl.
- **2026-10-03** — **Closed the live in-browser verification gap PR #113/#114
  both explicitly flagged as outstanding.** Both merged without a human
  click-through ever happening, so this was overdue, not optional. Root
  cause of the earlier Playwright failures was correctly diagnosed at the
  time (this sandbox's proxy throttling Chromium's naturally
  highly-parallel page loads) but never actually worked around — this
  session did: created a real throwaway account via the established
  `test-admin-setup` diagnostic pattern, drove Playwright against
  **production `aethyro.com`** (not the `*.workers.dev` preview
  subdomain the earlier attempts used), added `page.route()` blocking of
  non-essential third-party requests (GA, Google Fonts, Cloudflare
  challenge-platform/RUM) to cut concurrent-connection pressure on the
  proxy, and retried a few times through the remaining flakiness — exactly
  the kind of transient infra noise this file already tells future
  sessions not to mistake for a real bug. Confirmed clean on production,
  signed in as a real user:
  1. **Search tab** (Feature B) — opens, runs a real query against
     `embed-content` with no client error; 0 results is correct for a
     fresh account with no conversation/document history, not a bug.
  2. **React/JSX code-block preview** (Feature C) — confirmed on two
     independent clean runs: renders `Count: 0` in the sandboxed iframe,
     and clicking the real rendered button updates React state to
     `Count: 1` — proving the iframe's event handlers actually execute,
     not just that markup appears.
  3. **Python execution via Pyodide** (Feature D) — a real `print()` plus
     a list comprehension produced the exact expected
     `"hello from pyodide\nsquares: [0, 1, 4, 9, 16]"`, confirming the
     stdout-capture bug fixed in PR #114's own Node-harness testing also
     holds end-to-end in a real browser against the real CDN-hosted
     Pyodide runtime.
  One piece of real signal surfaced along the way, not a regression: a
  few runs hit `ReactDOM.createRoot is not a function` /
  `__SECRET_INTERNALS...` errors when the React/ReactDOM/Babel CDN
  scripts themselves got proxy-throttled mid-load on an otherwise-slow
  run — confirmed this was the CDN fetch failing (via
  `requestfailed`/`pageerror` listeners), not the app's own code, and a
  clean retry rendered correctly. Cleaned up: deleted the throwaway
  account, `test-admin-setup` re-stubbed to 410 and confirmed via a live
  curl (401 with no/invalid auth, matching this stub's established
  pattern).
- **2026-10-02** — **Added client-side Python execution** (PR #114, 4th of
  4 "serious AI tool" features from the same request — the other 3 are the
  entry directly below, PR #113). Extends the same Run-code mechanism with
  `python`/`py` via Pyodide (WASM CPython), loaded lazily from jsdelivr and
  cached across the page after first use. Auto-detects `numpy`/`pandas`/
  `matplotlib` imports and loads those packages before running. `_headers`
  also gained `cdn.jsdelivr.net` in `connect-src` — Pyodide's own
  `.wasm`/`.whl` fetches go through `connect-src`, a separate CSP
  directive from the `script-src` that already allowed loading
  `pyodide.js` itself; missing this would have let the script load but
  silently block its own runtime data, a subtle split-CSP failure mode
  worth remembering for any future WASM-runtime addition.
  **Found and fixed a real bug** while verifying the execution logic with
  the real `pyodide` npm package directly in Node (this session's sandbox
  browser proxy was badly rate-limiting Playwright's highly-parallel page
  loads today — see the entry below for the full root-cause — so this
  backend-shaped logic got verified this way instead of fighting the
  browser): the original `catch` block on a mid-run Python exception
  showed only the traceback, silently discarding any `stdout` that
  printed successfully before the crash (e.g. `print("before error");
  1/0` showed just the traceback, losing "before error"). Fixed by
  declaring the stdout/stderr buffers outside the `try` so the catch
  block can still include them; re-verified with the same Node harness
  after the fix — both the prior output and the traceback now show
  together. All CDN URLs confirmed reachable via direct `curl`, JS syntax
  of the full inline script verified via `node --check` after every edit.
  Live in-browser click-through confirmed the next day — see the
  2026-10-03 entry above.
- **2026-10-02** — **Added 3 of 4 "serious AI tool" features requested
  together** ("build the website AI further... implement all 4") — the 4th
  (Python code execution) is PR #114, stacked on this one, with its own log
  entry. Both PRs' outstanding "needs a real in-browser click-through"
  caveat was closed the next day — see the 2026-10-03 entry directly
  above. One of these three turned out to already exist from an earlier,
  undocumented session and only needed live verification; the other two
  were real new work.
  1. **Show reasoning** (no code change) — `chat`'s extended-thinking
     content (`thinking:{type:'adaptive'}`) was already streamed as a
     `THINK_MARK`-delimited block and already parsed client-side into a
     collapsible `.reasoning-panel`, just never exercised or documented
     here. Verified live via a real `chat` API call with a throwaway
     account: real reasoning content streamed correctly (confirmed the
     exact byte offsets of both `THINK_MARK` delimiters), followed by the
     real answer and accurate billing.
  2. **Cross-conversation/document semantic search** — new "Search" tab in
     the Intelligence panel. Needed zero backend changes:
     `embed-content`'s `type:"search"` handler and the
     `match_memory_embeddings`/`match_document_chunks` RPCs already
     existed from the earlier Intelligence-panel work, just never had a UI
     calling them with a user-typed query. Client merges and ranks both
     sources by cosine similarity; clicking a conversation result jumps to
     it via the existing `loadConversation()`, clicking a document result
     switches to the Knowledge tab. Verified both source branches live via
     direct `embed-content` API calls with a throwaway account (real
     ranked results for both memory and a real uploaded document) — the
     one document-embed call that initially came back
     `has_embeddings:false` was confirmed transient (an immediate retry
     succeeded), not a bug.
  3. **Artifacts-style live rendering, extended** — the existing Run-code
     mechanism (sandboxed iframe, already shipped for html/js/css from an
     earlier session) now also handles `svg` (raw markup) and
     `jsx`/`tsx`/`react` (loads React 18 + ReactDOM 18 + Babel standalone,
     auto-mounts the component via a name detected from
     `export default function X` / a conventional App/Index/Main
     fallback). **Used `cdn.jsdelivr.net` for these, not
     `cdnjs.cloudflare.com`** — `_headers`' CSP `script-src` only
     allowlists jsdelivr (already used here for marked/highlight.js), not
     cdnjs; verified by reading `_headers` directly rather than assuming.
  **Live in-browser click-through for #2/#3 was attempted repeatedly this
  session but never completed** — this sandbox's Playwright/Chromium
  traffic through the configured proxy kept hitting
  `ERR_TOO_MANY_RETRIES`, even though direct `curl` calls to the exact
  same hosts succeeded instantly and repeatedly throughout. Root-caused,
  not just retried blindly: one run got far enough to show the failure
  pattern tracks Chromium's naturally highly-parallel page-load requests
  (fonts, multiple CDN scripts, analytics, the API call itself, all
  firing concurrently) exhausting what looks like a low concurrent-
  connection cap on this session's proxy — curl's one-request-at-a-time
  pattern never hits it. Confidence for #2/#3 instead rests on: the
  `embed-content` API itself proven live and correct via direct `curl`
  (above); the new iframe/CDN-loading code mirroring this repo's already-
  shipped html/js/css pattern exactly; `node --check` syntax validation
  after every edit; and every new CDN URL confirmed reachable via direct
  `curl`. Live in-browser click-through for #2/#3 confirmed the next
  day — see the 2026-10-03 entry above.
  **Incidental finding, ruled out, not a bug**: a CSP violation
  (`style-src` blocking highlight.js's stylesheet) appeared in Playwright
  console logs during verification — checked via direct `curl -I` on both
  the `*.workers.dev` preview subdomain and the real `aethyro.com` domain;
  the CSP header only exists on Cloudflare's preview-subdomain default,
  not on the production custom domain (confirmed zero CSP header there at
  all). Not a real site bug, just a preview-environment artifact.
- **2026-09-30** — **Added a "Continue with Google" / "Sign up with Google"
  OAuth button to `app/login.html` and `app/signup.html`**, mirroring the
  existing GitHub OAuth button exactly (`supabase.auth.signInWithOAuth
  ({provider:'google', options:{redirectTo:nextAbs}})`, same click-handler
  shape, same `.btn-oauth` styling). User-requested ("add google sign in
  like the github sign in"). Notable: `app/admin.html`'s user-list table
  already had a `google` provider badge wired up (line ~880,
  `u.provider === 'google' ? '<span class="badge badge-blue">google</span>'`)
  with no corresponding sign-in button anywhere — this was a half-built
  feature, not a net-new one; this PR completes the client side of it.
  **What this PR does NOT and cannot do**: enable the Google provider
  itself in Supabase Auth. That's a project-level Auth setting
  (Authentication → Providers → Google in the Supabase Dashboard,
  requiring a Google Cloud OAuth 2.0 Client ID + secret with the
  redirect URI set to `https://uzmdqbtflcpikjdrggqc.supabase.co/auth/v1/
  callback`) with no equivalent in any available Supabase MCP tool —
  `execute_sql` can't reach it, it's not a database-level setting. Until
  that's done in the dashboard, clicking either new button will error
  (Supabase will reject an unconfigured `provider`). Confirmed via
  `get_project` that no tool here exposes Auth provider config — this is
  a manual step for a human, not something a future session can silently
  "finish" via SQL or a migration.
- **2026-09-30** — **`site-guardian` sweep, user-requested ("do a full site
  audit for anything else broken").** Ran the full checklist. Two real
  findings, both fixed; everything else clean.
  **Fixed**: `enforce_routine_chain()` (the `BEFORE INSERT OR UPDATE`
  trigger on `user_routines.next_routine_id` from the routine-chaining
  feature) had a mutable search_path — flagged by `get_advisors`, unlike
  every other function in this project which sets one explicitly. Not
  `SECURITY DEFINER`, so practical risk was low (it already only
  referenced fully-qualified `public.user_routines`), but fixed for
  consistency: `20260930020000_fix_enforce_routine_chain_search_path.sql`
  adds `SET search_path = public`. Verified via a real transactional test
  (self-chain and cycle both still correctly rejected, rolled back
  cleanly) and confirmed `get_advisors` no longer flags it.
  **Everything else checked clean**: `get_advisors` (security+performance)
  — the only performance findings are long-standing, low-priority,
  previously-un-actioned classes (unindexed FKs, RLS `auth.<fn>()`
  re-evaluation, unused indexes, multiple permissive policies on 3
  tables) — not fixed, consistent with every prior sweep's treatment of
  these as optimization rather than bugs; `list_edge_functions` vs.
  `supabase/functions/` — zero drift, all 22 real functions present,
  spot-checked the 4 intentionally-stubbed-to-410 functions
  (`create-checkout`/`activate-license`/`validate-license`/
  `customer-portal`) and confirmed none have regressed back to live;
  hard security constraint re-grepped clean (zero `buy.stripe.com`
  matches); `auth.users` triggers match the documented 4, all enabled,
  zero drift; no stale references to the decommissioned subscription
  model; `robots.txt`/`404.html`/`manifest.json`/OG tags all correct
  live; the 6 previously-decommissioned pages
  (`marketplace/`/`builder/`/`community/`/`contractors.html`/
  `app/community.html`/`app/packs.html`) all still correctly 404, no
  regression. 24h error-log sweep found one real-looking `500` on
  `send-welcome-email` — investigated via `function_logs` console output
  rather than assumed: it was Resend correctly refusing to send to
  `@example.com` (this session's own earlier throwaway test account,
  not a real customer), confirmed via timestamp correlation. Not a bug,
  no fix needed. Live smoke test with two real throwaway accounts:
  explicit `model:"haiku"/"sonnet"/"opus"` chat sends all succeeded (the
  historical thinking-param P0 only ever showed on Sonnet/Opus, so this
  is the specific regression class worth re-checking each sweep);
  referral redemption happy path (+100 credits), duplicate (409),
  self-referral (400), and invalid code (404) all correct;
  `buy-credits` resolves to a real `checkout.stripe.com` URL, never a
  bare `buy.stripe.com` link. Cleaned up: deleted both throwaway
  accounts, confirmed zero orphaned rows including `referral_events`
  cascade, `test-admin-setup` re-stubbed to 410 and confirmed via a live
  curl. See the entry directly below for the orphaned-SEO-pages finding
  from the same sweep.
- **2026-09-30** — **Fixed: three real SEO landing pages were completely
  orphaned from the rest of the site** (`site-guardian` sweep finding, see
  the sweep-summary entry above for the rest of that run).
  `use-cases.html`, `claude-opus-alternative.html`, and
  `ai-chat-for-developers.html` are real, complete, correctly-built pages
  (added 2026-09-26, commit "feat: add six product enhancements... SEO" —
  predates any session documented in this file) with proper titles,
  descriptions, and CTAs — but had **zero internal links from anywhere
  else in the site**, weren't in `sitemap.xml`, and had no
  `<meta name="robots">` tag at all. Confirmed via grep before fixing:
  not referenced by `index.html`, not by each other in all cases, not by
  `sitemap.xml`, not by any other page in the repo — reachable only by
  someone typing the exact URL. All the SEO value already built into
  them was going entirely to waste. Also found while checking: the 3
  pages' own mutual cross-linking was incomplete —
  `claude-opus-alternative.html` didn't link to either of the other two,
  and `ai-chat-for-developers.html` didn't link to `use-cases.html`.
  Fixed all of it: added `<meta name="robots" content="index, follow"/>`
  to all 3 (matching every other properly-configured SEO page in this
  repo), added all 3 to `sitemap.xml`, completed the missing cross-links
  between the 3 pages, and linked all 3 from `index.html`'s footer
  Product column — same remediation pattern this repo already used for
  `developers.html`/`routines.html` when they shipped. Verified live:
  all 3 pages still 200, zero horizontal overflow or console errors via
  a real Playwright render, `sitemap.xml` still valid XML.
- **2026-09-30** — **Code-level correctness review of auto-topup's success
  path** (user asked to "check auto-topup with a real test purchase" —
  offered three options via clarifying question, user chose the no-real-
  money code-review path over actually spending real dollars). Confirms
  the gap this file already flagged when auto-topup shipped ("the actual
  successful-charge path was never exercised with real money") is still
  open — no code changed here, this only narrows *how much* of the pipeline
  could plausibly be wrong. Checked live before reviewing: zero accounts
  currently have `auto_topup_enabled` or a saved `stripe_payment_method_id`
  — nobody has ever completed real setup, so this really is starting from
  zero. Reviewed, with the live deployed source diffed byte-for-byte
  against local disk (zero drift on `setup-auto-topup`, `stripe-webhook`,
  `auto-topup-charge`):
  1. **Dollar amounts, the highest-stakes thing to get wrong** —
     `auto-topup-charge`'s hardcoded `CREDIT_PACKS` cents
     (400/1000/3000/9000) were checked against the **live Stripe Price
     objects** themselves (`GetPricesPrice` on all 4 real price ids from
     `buy-credits/index.ts`), not just against another file in this repo.
     Exact match on both `unit_amount` and `credits` metadata for all 4
     packs. Also matches `dashboard.html`'s own `CREDIT_PACKS` display
     array and `setup-auto-topup`'s `VALID_PACKS`. Zero drift anywhere in
     a 4-file, 2-system (repo + live Stripe) chain that would have been a
     real "charged the wrong amount" bug if any one of them had drifted.
  2. **The low-credit/auto-topup trigger in `chat`'s `finalize()`** is a
     plain `await` that completes *before* `controller.close()` runs — not
     wrapped in `EdgeRuntime.waitUntil()` like the background memory-embed
     block elsewhere in the same function, and correctly so: since
     `finalize()` is itself `await`ed by both of its call sites, this path
     doesn't have the isolate-freeze race that bit the memory feature
     (documented above) — it isn't fire-and-forget, so it needs no
     `waitUntil()` protection to complete reliably.
  3. **`stripe-webhook`'s `mode === "setup"` branch** correctly retrieves
     the `SetupIntent` to get the confirmed `payment_method`, sets it as
     the customer's `invoice_settings.default_payment_method`, and only
     *then* flips `auto_topup_enabled` — so a checkout session that's
     `completed` but never actually confirms a working payment method
     can't silently turn auto-topup on with nothing usable behind it.
  4. **`auto-topup-charge`'s failure handling** disables
     `auto_topup_enabled` on any charge exception (declined card, SCA,
     expired card) rather than retry-looping on every subsequent
     low-balance message, and marks `auto_topup_last_attempt_at` *before*
     calling Stripe (not after), so two near-simultaneous chat requests
     both crossing the threshold can't double-fire. The `credit_ledger`
     insert reuses the existing `reason = 'purchase'` partial unique index
     on `stripe_session_id`, storing the PaymentIntent id (`pi_...`) —
     confirmed this is a distinct id namespace from Checkout Session ids
     (`cs_...`) used by real purchases, so it structurally can't collide.
  5. **`dashboard.html`'s setup button** passes the real session
     `access_token` as `Authorization: Bearer`, which `setup-auto-topup`
     correctly resolves via `supabase.auth.getUser(token)` — matches the
     already-Playwright-verified UI behavior documented in the auto-topup
     entry below.
  **What this review does NOT and cannot establish**: whether Stripe's
  real off-session confirmation flow (3DS/SCA handling, actual card
  network response, `off_session: true` behaving as expected end-to-end)
  actually works — that still requires a real card and a real charge,
  which remains a recommended manual step for a human with their own card,
  not something this review substitutes for.
- **2026-09-30** — **Added Phase 4: a public `/trust.html` page**, the last
  item from the original site-expansion blueprint (Phases 1-3 — routines/
  webhooks/chaining, the public API, the embedding auto-router — all
  shipped and merged earlier). Deliberately not a compliance-badge page —
  this project doesn't hold SOC 2/ISO 27001/etc. and the page says so
  explicitly, same "don't fabricate trust signals" lesson as the removed
  homepage testimonials. Content is grounded in what's actually true and
  checkable in this repo today: row-level security enforced at the DB layer
  on every table, `admin_users` unreachable from the client, API keys
  SHA-256-hashed and shown once, the real client-side HaveIBeenPwned check
  at signup, Stripe-hosted checkout (Aethyro never touches card numbers),
  Anthropic's no-training-on-API-inputs policy, and — the centerpiece —
  an explainer of the verifiable HMAC-signed deletion receipts feature
  (already shipped, documented above) framed as the actual differentiator
  it is. Includes an explicit "what we deliberately don't do" box and an
  "honest about scale" note (solo-built, no dedicated security team) rather
  than overclaiming. Linked from `index.html`'s footer (Company column) and
  added to `sitemap.xml`, matching the `developers.html`/`routines.html`
  precedent. **Found and fixed one real CSS bug while building it**: the
  checklist `<li>` items used `display:flex` with a `<strong>` label
  followed by plain text as direct children — per the flex spec, the
  `<strong>` element and the trailing text node become *two separate flex
  items*, not one wrapped paragraph, so each bullet rendered as a narrow
  bold column next to a disconnected description column instead of reading
  as one sentence. Fixed by wrapping each li's content in a single `<span>`
  so it's one flex item. Caught via a real Playwright render (both desktop
  and mobile viewports) before shipping, not just by reading the HTML —
  worth remembering generally: `display:flex` directly on an element with
  mixed inline-element-plus-text-node children needs everything wrapped in
  one child element, or the browser silently splits it into multiple flex
  items with only `gap` between them. Confirmed no horizontal overflow at
  either viewport and zero real console errors (only proxy-induced
  `ERR_CERT_AUTHORITY_INVALID` on the external Google Fonts/GA requests,
  an artifact of this sandbox's TLS-intercepting proxy, not a real page
  bug).
- **2026-09-29** — **Live regression/security pass over the three most
  recently shipped phases** (routines/webhooks/chaining, the public API, the
  embedding auto-router), user-requested ("test out the new implements to
  work out the bugs") rather than a scheduled `site-guardian` sweep. Found
  and fixed one real bug, verified everything else clean.
  **Found live**: `classify_router_tier` (Phase 3's classifier RPC, meant to
  be `service_role`-only — only `chat`'s internal routing call should reach
  it) was directly callable by any signed-in user. Its own migration
  (`20260928120000_model_router_centroids.sql`) revoked `EXECUTE` from
  `PUBLIC` and `anon` but never `authenticated` — same root cause as the
  earlier `api_keys`/`get_credit_balance` grant incidents already documented
  above: this project auto-grants `authenticated` `EXECUTE` on new functions
  via a default-privileges rule, and revoking from `PUBLIC`/`anon` doesn't
  touch that separate grant. Confirmed live via `has_function_privilege`
  before fixing (`authenticated_can_exec: true`) and after (`false`).
  Impact was low — the function only ever returns a bare `light`/`medium`/
  `heavy` label, never raw centroid data, and an RPC call isn't billed — but
  it broke the intended design and is exactly the class of bug this file
  already tells future sessions to check for. Fixed with
  `20260929230000_lock_down_classify_router_tier_authenticated.sql`
  (`REVOKE ALL ... FROM authenticated`), confirmed via `get_advisors`: the
  `classify_router_tier` finding is gone, nothing else changed.
  **Everything else verified clean** with a real throwaway account: (1)
  auto-router — `"thanks so much!"` → haiku, a photosynthesis explanation →
  sonnet, a novel API-key threat-modeling prompt → opus, all three billed
  correctly, and an explicit `model:"haiku"` on a heavy-sounding prompt
  correctly bypassed the router (no regression); (2) public API — created a
  real key via `create_api_key`, called `api-chat` with both the `message`
  shorthand and `messages` array forms (both billed `reason:'api_usage'`
  correctly), confirmed an invalid key 401s, a missing body and a
  `messages` array not ending in `user` both 400, and revoking the key via
  the owner-scoped `DELETE` immediately 401'd the next call; (3) routine
  chaining + webhooks — created two real routines, chained A→B, confirmed
  the DB trigger correctly rejected both a self-chain and a real cycle
  attempt, created a real webhook for A, fired it with **no Authorization
  header** (a real external caller has none) via the exact
  `?token=...`-query-param URL `chat.html` actually generates (a first
  attempt using a path-style URL failed with `"token required"` — that was
  my own wrong URL shape in testing, not a bug: confirmed via grep that
  `chat.html`'s real webhook modal only ever builds the query-param form),
  and confirmed the full chain ran automatically end-to-end: A's real
  output (`"ALPHA"`) was billed and then correctly passed as
  `chain_context` into B, whose real output explicitly referenced it
  (`"...previous step said ALPHA"`), with both steps billed
  `reason:'routine'`. Also re-confirmed signup still produces exactly one
  `profiles`/`signup_bonus` row (no regression of the old double-bonus
  bug). Cleaned up: deleted all test routines/webhooks/the API key/the
  throwaway account, confirmed zero orphaned rows across
  `profiles`/`credit_ledger`/`conversations`/`memory_embeddings`/
  `api_keys`/`user_routines`/`routine_webhooks`/`referral_codes`/
  `referral_events`/`deletion_receipts`, `test-admin-setup` re-stubbed to
  410 and confirmed via a live curl.
- **2026-09-28** — **Added Phase 3: a smarter `model:"auto"` router**
  backed by a real embedding classifier, replacing the old keyword/length
  heuristic (`routeAutoModel()`, now only the fallback) as the primary
  resolver. Nearest-centroid classification: 3 reference vectors
  (light/medium/heavy, unit-normalized mean `voyage-4-lite` embeddings
  over ~25 curated example prompts per tier) stored in a new
  `public.model_router_centroids` table, queried via a new
  `classify_router_tier(p_embedding)` SQL function using pgvector's `<=>`
  operator — same pattern `match_memory_embeddings`/`match_document_chunks`
  already use for semantic retrieval, just applied to routing. `chat`'s
  existing `embedText(message)` call (already made for semantic memory/
  document retrieval) is reused for classification too — zero added
  Voyage calls, zero added latency. Leave-one-out cross-validation on the
  75-example training set: 94.7% accurate, and every one of the 4 misses
  was an adjacent-tier confusion (light↔medium on short factual
  questions) — never a light/heavy or medium/heavy mix-up. Separately
  spot-checked against 10 genuinely novel prompts not in the training
  set; all 10 classified as a human would expect. The old keyword-signal
  list (`AUTO_HEAVY_SIGNALS`) and the attachment rule are kept as
  asymmetric safety nets on top of the classifier's result — both can
  only push the tier *up* (toward Opus), never down, so the embedding
  classifier can never be the thing that trivializes a security/legal/
  architecture question or a document/image attachment.
  **Deliberately not stored as source-code literals** — see the incident
  below for why. Verified live end-to-end with a real throwaway account:
  a trivial "thanks so much!" → haiku, a real factual-explanation prompt
  → sonnet, and a genuinely novel security/threat-modeling prompt (not
  in the training set) → opus, all three with correct billing; explicit
  `model:"haiku"` still resolves to haiku with no regression. Cleaned
  up: deleted the throwaway account and the `test-embed-batch` diagnostic
  function's data, confirmed zero orphaned rows, `test-admin-setup`
  re-stubbed to 410 and confirmed via a live curl. `chat` now at v37.
  **A real, brief production incident happened building this, worth
  recording in full:** the first implementation embedded all 3 centroid
  vectors (~30KB of raw float literals, ~1024 numbers × 3) directly in
  `chat/index.ts`. Deploying that ~64KB file failed **twice** — the
  content silently truncated mid-transmission both times, once leaving
  the deployed function with no request handler at all (missing
  `serve(...)` entirely) — meaning **every chat request failed** for
  roughly 3 minutes between the bad deploy and the fix. Caught
  immediately via a live smoke test (not by a user report), and fixed by
  redeploying the exact last-known-good committed source, verified
  byte-for-byte via a SHA-256 hash comparison and a full fetch-back diff
  against `get_edge_function` before trusting it live again. Root cause
  wasn't a real size limit — it was generating a very large single piece
  of literal content in one deploy call being unreliable in practice.
  Rebuilt with the DB-backed design above instead (small edge-function
  source, centroids seeded via three separate, smaller `INSERT`
  statements instead of one combined blob), which both fixed the
  transmission risk and turned out to be the more idiomatic design for
  this codebase anyway. **Lesson for this repo generally: never embed
  large generated data blobs (large float/vector arrays, long lookup
  tables, etc.) as source-code literals in an edge function.** Put them
  in the database (a table, queried at request time — this project
  already has the pgvector infrastructure for exactly this) instead, and
  keep function source small enough to transmit reliably in one deploy
  call. If a large one-time data load is ever unavoidable, split it into
  several smaller calls rather than one large one, and always verify a
  large deploy by fetching the live source back and diffing it against
  local disk before trusting it — don't just trust the deploy call's own
  success response.
- **2026-09-28** — **Added Phase 2: a public, metered API** (`api-chat`),
  the second phase of the site-expansion blueprint (Phase 1 was
  webhook-triggered routines + chaining, above). Lets a user call
  Aethyro's models from their own code — scripts, backend services, CI —
  with a long-lived API key instead of a browser session, billed against
  the same team-pool-aware credit balance as chat.html. New `api_keys`
  table (`user_id`, `name`, `key_prefix` — first 16 chars, shown in the
  UI — `key_hash` — sha256, plaintext never stored — `last_used_at`,
  `request_count`) and a `create_api_key(p_name)` SECURITY DEFINER RPC
  that generates the real key server-side and returns the plaintext
  exactly once; revocation is a plain owner-scoped `DELETE`, no
  soft-revoked flag, same shape `routine_webhooks`' regenerate already
  uses. New public (`verify_jwt: false`) `api-chat` function: resolves
  the key via sha256 lookup, checks credit balance, calls Claude
  (stateless — caller sends full message history each request, same
  shape most public completion APIs use), bills `credit_ledger` with a
  new `reason: 'api_usage'` (added to `credit_ledger_reason_check` in the
  same migration as the feature that introduces it — see the
  routine/agent_task entry below for exactly what happens when that step
  gets skipped) stamped with `team_id`, and updates the key's
  `last_used_at`/`request_count`. New `app/dashboard.html` "API Keys"
  panel (list, create — reveals the plaintext once in a dedicated box the
  list-refresh never touches — revoke). New public, SEO-indexable
  `developers.html` (quickstart curl example, auth, request shape,
  pricing table matching the real `CREDIT_RATES`, error codes, and an
  honest "known v1 gaps" note: no hard per-key rate limit beyond the
  credit balance itself, no streaming, no `auto` model routing on this
  endpoint yet) — linked from `index.html`'s footer and `sitemap.xml`,
  same pattern `routines.html` used for Phase 1.
  **Found and fixed a real grant bug while verifying live**: this
  project auto-grants full `ALL`-privilege table access to
  `anon`/`authenticated` via a default-privileges rule that fires on
  every new table in `public` — the first migration's column-scoped
  `GRANT SELECT (id, name, key_prefix, ...)` never actually narrowed
  anything, since a GRANT is additive, never restrictive, and the
  broader default-privilege grant underneath it still gave
  `authenticated` full-table `SELECT` (confirmed live: a real
  authenticated session's raw REST call for `select=id,key_hash`
  returned the real hash for a still-live key), plus `INSERT`/`UPDATE`,
  and gave `anon` `SELECT`/`INSERT` too. Practical exploit surface was
  narrow (RLS's `auth.uid() = user_id` check still blocked anon's
  INSERT, and an authenticated user self-inserting/updating only ever
  touches their own row), but it defeated the point of hashing the key
  and broke the "only `create_api_key()` mints a row" invariant. Fixed
  with a follow-up migration doing an explicit `REVOKE ALL ... FROM
  authenticated, anon` before the narrow re-grant — confirmed via
  `has_table_privilege`/`has_column_privilege` per role, not just by
  re-reading the grant statements, same lesson as the earlier
  `get_credit_balance` anon-grant incident below. **Worth checking
  `has_table_privilege('authenticated', '<new table>', 'INSERT')` right
  after creating *any* new table in this project from now on** — a plain
  `GRANT SELECT (...)` is not a ceiling here, it's a floor, unless
  preceded by an explicit `REVOKE ALL`. Verified live end-to-end with a
  real throwaway account: `create_api_key` RPC returned a real
  `ak_live_...` key; a real `api-chat` call (both the `message` shorthand
  and the `messages` array form) billed correctly (`-1, reason:
  'api_usage'`, `credits_remaining` accurate) and updated
  `last_used_at`/`request_count`; an invalid key correctly 401s; missing
  body and a `messages` array not ending in a `user` turn both correctly
  400; revoking via a real RLS-scoped `DELETE` immediately 401'd the same
  key on the next call. Cleaned up: deleted the throwaway account,
  confirmed zero orphaned rows (`api_keys`/`credit_ledger`/`profiles`/
  `auth.users`), `test-admin-setup` re-stubbed to 410 and confirmed via a
  live curl. `api-chat` deployed live at v1. Not yet done from the same
  blueprint: Phase 3 (a narrow fine-tuned model) and Phase 4 (a `/trust`
  page) are still pending.
- **2026-09-28** — **Added multi-step routine chaining** (the other half of
  Phase 1's automation-depth expansion, alongside webhook-triggered
  routines above). A routine can now name a `next_routine_id` — another
  routine of the same user's, run immediately after this one completes,
  with this routine's output prepended as context ("Context from the
  previous step in this routine chain: ... Your task: ..."), turning a
  single scheduled prompt into a pipeline (e.g. "scrape + summarize" then
  "draft an email from that summary") without gluing them together by
  hand. New nullable self-referential `user_routines.next_routine_id`
  column (migration `20260928090000_routine_chaining.sql`) plus a
  `BEFORE INSERT OR UPDATE OF next_routine_id` trigger
  (`enforce_routine_chain()`) that rejects self-chaining, rejects
  chaining to a routine owned by someone else, and walks the proposed
  chain forward to reject any cycle — runs under the caller's own
  RLS-scoped rights (no `SECURITY DEFINER` needed, since the target
  lookup is either the caller's own row or, for a public routine, still
  correctly fails the explicit `user_id` match). `run-routines/index.ts`
  gained `chain_context`/`chain_depth` request-body fields and, after a
  successful run, an **awaited** (not fire-and-forget — same
  `EdgeRuntime.waitUntil()` isolate-freeze risk noted elsewhere in this
  file) internal re-invoke of itself for `next_routine_id` with the
  result as `chain_context`, using the same
  `Authorization: Bearer <service-role-key>` internal-caller pattern
  `webhook-routine-trigger` already established. `MAX_CHAIN_DEPTH = 5` is
  a runtime backstop independent of the DB trigger's own cycle rejection
  (guards a long legitimate chain from looping credits away, not just a
  true cycle). `chat.html`'s routine form gained a "Then run (optional)"
  select, and each routine card gained a chain indicator plus a "➜
  Chain" button to set/change/clear the target inline. Verified live
  end-to-end with a real throwaway account and two real chained
  routines: the DB trigger correctly rejected a self-chain attempt and a
  true A→B→A cycle attempt (both rolled back cleanly, confirmed via
  direct state check after each), and — separately, since the DB
  connection itself hit a few transient gateway 502s mid-session,
  confirmed each time via a direct state re-check that nothing had
  actually mutated — a real chain-to-another-user's-routine attempt
  against the live admin account's own real routine left both rows
  untouched. The real end-to-end run (`run-routines` called once, for
  routine A only) correctly ran both steps automatically: A produced a
  specific real fact, B's real output explicitly built on that exact
  fact (proving `chain_context` actually reaches the model, not just
  that the second call fires), and `credit_ledger` shows two separate
  real `-1, reason: 'routine'` charges per full chain run. Cleaned up:
  deleted both test routines and the throwaway account, confirmed zero
  orphaned rows (`user_routines`/`credit_ledger`/`profiles`/`auth.users`
  all zero for the test id), `test-admin-setup` re-stubbed to 410 and
  confirmed via a live curl. `run-routines` now at v7.
- **2026-09-28** — **Added webhook-triggered routines** (Phase 1 of a
  site-expansion pass, prioritized by real demand research: workflow
  automation is the single most-requested AI SaaS capability across every
  survey checked). A routine (`chat.html`'s Intelligence → Routines tab)
  could previously only fire on its own cron schedule or a manual "Run
  now" click from inside the app; it can now also be triggered from
  outside Aethyro entirely — GitHub Actions, Zapier, IFTTT, a script, any
  system that can make an HTTP request — by hitting a per-routine URL
  containing a secret token, independent of its schedule. New
  `routine_webhooks` table (`routine_id`, `token` — random, unique,
  DB-generated default — `last_triggered_at`, `trigger_count`); RLS
  ownership is derived from a join to `user_routines` (same pattern as
  `agent_task_steps`' `steps_own` policy), so the owner can create/view/
  delete their own routine's webhook row directly via `supabase-js`, no
  edge function needed for that half. New public
  `webhook-routine-trigger` function (`verify_jwt: false` — auth is the
  token itself, not a Supabase session, since callers have no Aethyro
  account) looks the token up, enforces a 30-second cooldown (same
  mark-before-charging concurrency-guard pattern as `auto-topup-charge`,
  so a leaked/spammed token can't rack up unbounded credit charges), then
  invokes `run-routines` as the service role for just that one routine —
  the same internal-caller path `pg_cron` itself already uses
  (`Authorization: Bearer <service-role-key>`, body `{routine_id}}`),
  which `run-routines` already recognized and skipped the per-user JWT
  lookup for. New "🔗 Webhook" button per routine card opens a modal
  (mirrors the existing referral-link modal's markup/JS pattern exactly)
  showing the full trigger URL with a copy button and a "Revoke &
  regenerate" action (delete + re-insert, since the token's `DEFAULT`
  re-generates it — no `UPDATE` grant needed on the table at all).
  Verified live end-to-end with two real throwaway accounts: a non-owner
  correctly blocked by RLS from creating a webhook for someone else's
  routine (`42501`); the owner's real webhook token, hit with **no
  Authorization header at all** (simulating a real external caller),
  correctly fired the routine (`last_run_at`/`last_result` updated) and
  correctly billed a real `-1, reason: 'routine'` ledger row; an
  immediate second hit correctly cooldown-blocked (`429`); an invalid
  token correctly `404`s. Zero orphaned rows after cleanup, including
  confirming `routine_webhooks`' cascade-delete through
  `user_routines → auth.users`. Migration:
  `20260928080000_routine_webhooks.sql`. Multi-step routine chaining
  (the other half of this phase) is still pending, deliberately shipped
  as a separate PR rather than bundled into this one.
- **2026-09-28** — **Fixed: `run-routines` and `run-agent-task` had never
  successfully billed a single credit, ever, since either was written.**
  Found while starting work on an automation/routines expansion (user asked
  to prioritize this after a demand-research pass showed workflow
  automation as the most-requested AI SaaS capability across every survey
  checked). Both functions insert a `credit_ledger` row with
  `reason: 'routine'` / `reason: 'agent_task'`, but
  `credit_ledger_reason_check` only ever allowed
  `purchase/chat_usage/signup_bonus/admin_adjustment/referral_bonus` —
  every such insert has been silently failing with a `23514` check
  violation since day one, and neither function checked the insert's
  returned error, so nothing ever surfaced it. Confirmed live before
  fixing: the one real `agent_tasks` row in this project shows
  `credits_used: 12` on its own record, but zero matching `credit_ledger`
  row exists anywhere — it ran a real Claude task for free and the
  ledger never moved. No `user_routines` row had ever actually executed
  yet (`last_run_at` was null for all of them), so that half of the bug
  hadn't hit a real balance yet, but would have identically the first
  time a routine fired. Separately, neither function stamped `team_id`
  on its ledger insert at all — a gap in PR #100's team-pool rollout,
  which updated `chat`/`stripe-webhook`/`auto-topup-charge` but missed
  these two. Fixed both in the same pass: migration
  `20260928070000_fix_routine_agent_task_billing.sql` extends the CHECK
  constraint to include `routine`/`agent_task`; both functions now also
  select the caller's `profiles.team_id` and stamp it on their ledger
  insert, and both now log (not swallow) the insert's error if one
  occurs. Verified live end-to-end with a real throwaway account: a real
  `run-agent-task` call now produces a real `-10, reason: 'agent_task'`
  ledger row and a correctly reduced balance (200→190); a real manually
  -triggered routine now produces a real `-1, reason: 'routine'` row
  (190→189). Cleaned up, `test-admin-setup` re-stubbed to 410, confirmed
  via a live curl. **If you add a new `credit_ledger.reason` value
  anywhere in this codebase, add it to `credit_ledger_reason_check` in
  the same migration — this bug is exactly what happens when you don't,
  and the insert fails silently unless the caller explicitly checks the
  returned error, which most of this codebase's fire-and-forget billing
  calls don't.**
- **2026-09-28** — **`site-guardian` sweep after merging PRs #96-#100 found
  and fixed a live P0: auto model routing (PR #97) was silently dead in
  production.** Root cause was a gap this project hadn't hit before:
  Cloudflare Workers auto-deploys the frontend on every `git push` (so
  `chat.html`'s new "Auto" model selector — the default for any user with
  no stored `aethyro_model` preference — went live the moment PR #97
  merged), but **Supabase edge functions do not auto-deploy on push at
  all** — they only update when something explicitly calls
  `deploy_edge_function`. PR #97's `routeAutoModel()` logic was merged
  into `main`'s `supabase/functions/chat/index.ts` (confirmed via the
  merge-conflict resolution work that produced this file's current
  `chat` source — see PR #97/#98/#99/#100's conflict-resolution history),
  but nothing ever redeployed the live Supabase function afterward — PR
  #99's and #100's own deploys were of `feat/auto-topup`/
  `feat/team-credit-pool` branch state, which (at the time each was
  deployed, before this session's later merge-conflict resolution)
  predated PR #97 entirely. The result: the **live** `chat` function
  (confirmed via `get_edge_function`, deployed version 38) still had the
  pre-#97 `const modelKey = ["haiku","sonnet","opus"].includes(body.model)
  ? body.model : "haiku"` line — no `routeAutoModel`, no `requestedModel`
  anywhere in the deployed source, despite both being present in `main`'s
  committed source and in the other three redeployed functions
  (`stripe-webhook`, `auto-topup-charge`, both confirmed byte-for-byte
  matching local source). Every message sent with `model:"auto"` (i.e.
  every new/unset-preference user, by default) was silently falling back
  to Haiku server-side — the cheapest, weakest model — while the client
  UI showed "Auto" selected and no error appeared anywhere; nothing
  crashed, so this had zero chance of being caught except by explicitly
  diffing deployed-vs-committed source, which is exactly what this sweep
  did. Fixed by redeploying `chat` from `main`'s current source (now live
  as v39). **Verified live end-to-end** with two real throwaway accounts:
  confirmed exactly one `signup_bonus` row each (no regression of the
  double-bonus bug); `model:"auto"` on `"thanks!"` → haiku, a full
  security-audit prompt → opus, a plain factual question → sonnet, all
  three correctly reporting `requestedModel:"auto"` alongside the
  resolved `model`; explicit `model:"sonnet"` still resolves to sonnet
  with `requestedModel:"sonnet"` (no regression); team credit pooling
  (PR #100) still works correctly post-redeploy — two accounts on a
  real team saw matching pooled balances before and after a real spend
  (100→99 on both sides); the `get_credit_balance(uuid)`-overload
  lockdown (PR #100's second bug fix) still correctly blocks both `anon`
  and an unrelated `authenticated` caller. Zero orphaned rows after
  cleanup (`profiles`/`credit_ledger`/`teams` all confirmed empty for
  both test ids, including the owned team's cascade-delete).
  **Lesson for this repo generally: a merge-conflict resolution that
  only touches `main`'s git history is not the same as a deploy** — for
  any edge function whose source changes as part of resolving a
  cross-PR conflict (not just a fresh feature build), explicitly
  redeploy it afterward and diff `get_edge_function`'s live source
  against the repo before trusting it's current. `get_advisors`
  (security+performance) run and diffed against what's already
  documented here — nothing new beyond existing accepted findings (the
  zero-policy tables, GraphQL-exposure boilerplate, the two intentional
  anon-executable 0-arg `SECURITY DEFINER` functions). `list_edge_functions`
  vs. `supabase/functions/` showed no other drift — `setup-auto-topup`
  and `team-manage` both confirmed byte-for-byte matching local source.
  Hard security constraint re-grepped clean (zero `buy.stripe.com`
  matches). `routines.html` and all other static pages confirmed live
  (200) with correct titles. Diagnostic helper (`test-admin-setup`,
  redeployed for this sweep with a session-only key since this shell had
  no access to `SUPABASE_SERVICE_ROLE_KEY`) re-stubbed to 410 immediately
  after, confirmed via a live curl.
- **2026-09-28** — **Added team accounts: shared credit pool** (PR #100,
  item 5 of 5 from the "make the site significantly better, do all"
  request — items 1-4 are PRs #96-99 above; user picked "shared credit
  pool only" when asked to scope it, out of 4 options ranging from that
  to full admin-managed seats). Built on top of `feat/auto-topup` (PR #99)
  rather than `main`, since it touches the same `profiles`/`credit_ledger`
  surface auto-topup does and needed to compose with it correctly — will
  need rebasing onto `main` once #99 merges. Conversations, documents, and
  memory all stay private per-user; only the credit balance is shared.
  New `teams` table + `profiles.team_id` (at most one team per user,
  never client-writable — only the new `team-manage` function, service
  role, can change it) + `credit_ledger.team_id` (stamped on new
  chat_usage/purchase rows going forward by `chat`/`stripe-webhook`/
  `auto-topup-charge`; existing rows never backfilled, so pre-team credit
  history reappears if a user leaves). `get_credit_balance` (both
  overloads) is now team-pool-aware. `team-manage`: create/invite/remove/
  leave/list — no disband/delete-team action, since "where does the
  leftover pool balance go" is a real product decision this pass
  deliberately doesn't make. New "Team" panel in `dashboard.html`.
  **Two real bugs found and fixed live** while verifying with two real
  throwaway accounts on the same team: (1) `get_credit_balance` needed
  `SECURITY DEFINER`, not the `SECURITY INVOKER` it started as —
  `credit_ledger`'s only SELECT policy is strictly own-rows-only
  (`user_id = auth.uid()`), so a non-owner team member's aggregate query
  had that RLS policy silently ANDed underneath its own `WHERE team_id =
  X`, limiting the sum to only ledger rows *they themselves* created;
  caught because two real accounts on the same team showed different
  balances (100 vs 0) before the fix. Safe specifically because the
  function only ever returns one aggregate integer, never raw rows.
  (2) That same fix initially over-granted — a naive `SECURITY DEFINER`
  on the `(uuid)`-argument overload with `authenticated`/`anon` still
  able to call it would have let any signed-in (or even fully
  unauthenticated) caller pass an arbitrary other user's id and read
  their exact balance; confirmed this was really exploitable with a real
  second account and a bare curl before locking that overload down to
  `service_role` only. Worth remembering generally: **`REVOKE ALL ...
  FROM PUBLIC` does not remove a role's own separate, earlier *explicit*
  grant** — `anon` kept its execute grant on the `(uuid)` overload through
  the first fix attempt (inherited from the function's pre-team
  definition) until revoked from `anon` by name specifically; checking
  `has_function_privilege(role, oid, 'EXECUTE')` per-role is what caught
  it, not just re-reading the `REVOKE`/`GRANT` statements. Verified live
  end-to-end: pooled balance correctly shared and correctly drained by
  either member's real chat message; non-owner invite/remove correctly
  403; invite of a nonexistent email 404s; remove/leave correctly revert
  a member's frozen personal balance; an unrelated authenticated user
  sees an empty team list (not an error); a client cannot write
  `profiles.team_id` under any circumstance (confirmed both the "not
  granted" case and, for the `teams` table's own RLS, the "authenticated
  but unrelated" case returns `[]` cleanly). Zero orphaned rows after
  cleanup (`teams` cascade-deletes via `owner_id -> auth.users ON DELETE
  CASCADE`).
- **2026-09-28** — **Added opt-in auto-topup** (PR #99, item 4 of 5 from the
  "make the site significantly better, do all" request — items 1-3 are PRs
  #96-98 above; user picked "threshold-based, same pack size" when asked).
  When a user's balance drops to the existing 30-credit low-credit
  threshold, `chat`'s `finalize()` now optionally fires a real off-session
  Stripe charge (via the new `auto-topup-charge` function) alongside the
  existing warning email, instead of only emailing. Off by default —
  opt-in from a new "Auto-topup" panel in `dashboard.html`, which saves a
  card via a Stripe Checkout **setup**-mode session (new `setup-auto-topup`
  function; `stripe-webhook` gained a `mode === "setup"` branch that sets
  the customer's default payment method and flips `auto_topup_enabled` on
  once the card is actually confirmed — same session-then-webhook split as
  the real purchase flow). Pack size is chosen at opt-in (defaults to the
  user's most recent purchase) and can be turned off instantly from a
  direct client-side write. On any charge failure (declined card, SCA/
  `authentication_required`, expired card, etc.) `auto-topup-charge`
  disables `auto_topup_enabled` rather than retry-looping — the existing
  low-credit email still fires as a fallback. New `profiles` columns:
  `auto_topup_enabled`, `auto_topup_pack` (client-writable — bounded by a
  CHECK constraint and re-validated server-side, so a bad value is
  harmless), `stripe_payment_method_id`, `auto_topup_last_attempt_at`
  (both service-role-only, `authenticated` has no grant on them at all).
  Migration `20260928050000_auto_topup.sql`.
  **Two unrelated bugs found and fixed while building this, both live in
  production before the fix:** (1) `authenticated` had no `UPDATE` grant
  on `profiles.workspace_context`/`memory`/`updated_at` at all — so
  `chat.html`'s Workspace Context save and per-entry structured-memory
  delete had been silently 42501'ing since whichever session shipped them,
  confirmed with a real throwaway session before the fix. (2) This file's
  own "Database schema gotchas" claim that purchase rows use
  `reason LIKE 'pack:%'` was backwards — real purchases use a bare
  `reason = 'purchase'` literal with the pack name in
  `metadata.credit_pack` (confirmed against `stripe-webhook`'s actual
  source and the live partial unique index) — `dashboard.html`'s credit
  history had the same wrong assumption baked in
  (`row.reason.replace(/^pack:/, ...)`, which never matched anything real
  since no purchase has ever landed in this project yet) and both are
  fixed in the same PR; see the corrected gotcha above.
  **Verification is more limited here than usual and that's worth
  flagging explicitly**: this Stripe account has no test-mode counterpart
  available in this environment (`list_available_accounts_or_orgs` shows
  only `livemode: true`), so the actual successful-charge path was never
  exercised with real money, deliberately. What *was* verified live: (a)
  `setup-auto-topup` creates a real, correctly-shaped Stripe Checkout
  setup session (inspected the response, never visited/completed it with
  card details); (b) a real low-balance chat message with
  `auto_topup_enabled` true and no saved payment method correctly no-ops
  (confirmed zero Stripe calls, zero side effects); (c) a real low-balance
  chat message with a garbage/nonexistent `stripe_payment_method_id`
  correctly reaches Stripe, gets rejected (no real resource to charge, so
  provably zero money risk), and correctly disables `auto_topup_enabled`
  with zero credits granted and zero `credit_ledger` rows written; (d)
  the dashboard UI's on/off states, the real "Turn off" button (direct DB
  write, confirmed), and the "Set up" button (confirmed it reaches the
  real deployed function and redirects to a genuine `checkout.stripe.com`
  URL) — all via Playwright against the live backend. **What was not, and
  could not safely be, verified**: an actual successful off-session charge
  completing and granting credits. Recommend a human do one real manual
  test purchase with their own card before fully trusting the success
  path.
- **2026-09-28** — **Added a public community routines gallery** (PR #98,
  item 3 of 5 from the "make the site significantly better, do all"
  request — items 1-2 are PRs #96-97 above). New top-level,
  SEO-indexable `routines.html` (real `<title>`/description, `robots:
  index,follow`) lists public routines (`user_routines` where
  `is_public = true`) for logged-out visitors with a one-click "Fork this
  routine" CTA — the public-facing counterpart to the in-app,
  logged-in-only gallery already in `chat.html`'s Intelligence panel.
  Zero public routines exist yet, so the page shows an honest empty state
  plus 4 clearly-labeled "Starter ideas" (explicitly captioned as not
  from real users) rather than fabricating community activity — same
  lesson as the testimonials fix. **Found and fixed a real bug while
  verifying live**: `anon` had every table-level grant on
  `user_routines` except `SELECT`, so `routines_public_read`'s RLS
  policy was unreachable for logged-out requests (always 401'd) — see
  the new schema-gotchas bullet below. Migration
  `20260928040000_grant_anon_select_public_routines.sql`. Verified live
  end-to-end with throwaway accounts: seeded a real public routine,
  confirmed the page renders it (not the starters), forked it as a
  second account, confirmed the new private/disabled copy and the
  `fork_count` increment, confirmed zero orphaned rows after cleanup.
  Also confirmed live that a private row and a restricted column
  (`user_id`) both stay correctly inaccessible to `anon` after the grant.
  Added a footer link from `index.html` and a `sitemap.xml` entry. Items
  4 (auto-topup) still pending; item 5 (team/shared-pool accounts) still
  held for a scope check.
- **2026-09-28** — **Added auto model routing to chat** (PR #97, item 2 of 5
  from the "make the site significantly better, do all" request — item 1,
  the fabricated testimonials, is PR #96 above). Added an "Auto" option to
  `chat.html`'s model selector, now the default for anyone with no stored
  `aethyro_model` preference. The `chat` edge function (now v34) gained
  `routeAutoModel(message, attachments)`: a synchronous, rule-based
  heuristic (message length, a keyword list, attachment presence — never
  a second LLM call) that resolves `model:"auto"` to a real haiku/sonnet/
  opus key before the Anthropic request. Billing and the credit_ledger
  `metadata.model` use the *resolved* model, same as an explicit choice;
  `USAGE_MARK`'s `cost` object gained `requestedModel` so the per-message
  cost badge can show `auto→opus` instead of a bare `opus` when routing
  picked it. Verified live with a throwaway account: `"thanks!"` → haiku,
  a plain question → sonnet, a security-audit/architecture-analysis
  prompt → opus, all billed correctly; explicit `model:"sonnet"` still
  resolves to sonnet with no regression. Cleaned up the throwaway account
  and re-stubbed `test-admin-setup` to 410 (confirmed with a live curl).
  Items 3-4 (public routines gallery, auto-topup) still pending; item 5
  (team/shared-pool accounts) is still being held for an explicit user
  scope check before touching RLS.
- **2026-09-28** — **Removed the fabricated homepage testimonials** (PR #96,
  1 of 5 "make the site significantly better" recommendations the user asked
  for — "do all"). The three "Community feedback" quotes attributed to
  "Alex M." (CTO), "Rachel T." (consultant), and "Sami K." (platform
  engineer) were invented personas, not real customers — this had been
  tracked as an open P0 in "Open TODOs" below since 2026-09-27. Removal, not
  replacement, since this project genuinely has no real customer base yet to
  draw honest quotes from (per this file's own history, effectively 1-2 real
  signups total). Replaced the section with a plain, honest statement of the
  product's actual stage plus the existing Discord CTA and a new "Try it
  free" CTA. Also removed the now-dead `.testimonials-grid`/`.tcard*` CSS and
  a dead `.tcard` scroll-reveal JS selector. Verified locally with Playwright
  (served `index.html`, confirmed zero "Rachel T."/"Sami K." anywhere and
  zero "Alex M." inside the testimonials section specifically — one
  unrelated "Alex M." remains as a placeholder avatar label in the separate
  product-demo UI mockup further down the page, never a customer quote, left
  alone — and no new console errors). Items 2-4 of the same "do all"
  request (auto-model-routing, a public routines gallery, auto-topup) are
  still in progress; item 5 (team/shared-pool accounts) is being held for an
  explicit scope check with the user before any RLS/schema work, since
  "team accounts" is ambiguous and that item touches security boundaries
  across nearly the whole schema.
- **2026-09-28** — **Removed the pre-Cloud "AI Operating Platform" pages**
  (the two `site-guardian` findings from the sweep below), on explicit
  instruction after confirming via `git log --diff-filter=A` that all 5
  predate the Aethyro Cloud pivot by ~3.5 months (`marketplace/`,
  `builder/`, `community/` all first committed 2026-06-01 in one "Launch
  AI Operating Platform" commit; `contractors.html` 2026-06-07;
  `app/community.html` 2026-05-31, one day earlier, its own commit
  message showing it *was* originally linked from the dashboard before
  that link got repointed to Discord during the pivot). See
  "Decommissioned: pre-Cloud 'AI Operating Platform' pages" above for full
  detail — confirmed no real leads/data existed to lose (contractors.html's
  waitlist endpoint `/site/email/signup` returns a live 405, so it never
  actually worked), deleted all 5 files, removed their 4 `sitemap.xml`
  entries, and dropped the now-fully-dead forum schema
  (`forum_threads`/`forum_posts`/`forum_reports` + 3 trigger functions,
  migration `20260928030000_drop_orphaned_forum_schema.sql`) after
  re-confirming zero rows and zero other references immediately before
  dropping.
- **2026-09-28** — **Full `site-guardian` sweep, user-requested** ("do a
  full web and code audit to find and fix bugs and fix broken pages and
  clean dead code"). Ran the complete checklist: `get_advisors`
  (security + performance) diffed against what's already known/accepted
  here; `list_edge_functions` vs. `supabase/functions/` (no drift — every
  live function is committed, `test-voyage-probe`/`test-embed-probe`
  turned out already properly stubbed to 410 from a prior session, false
  alarm on first glance); `query_logs` for 24h of 4xx/5xx across all
  active functions (only expected-error-path codes — the `embed-content`
  401s were all pre-fix historical, last one at 22:30 UTC on 9/27, none
  since); `pg_trigger`/`pg_constraint` on `auth.users` re-verified against
  what this file already claims (exact match, zero drift); a full live
  smoke test with a real throwaway account (signup produces exactly one
  `profiles`/`referral_codes`/`signup_bonus` row — no regression of the
  earlier double-bonus bug — and a real chat message on **all three**
  `MODEL_MAP` keys, haiku/sonnet/opus, each returned 200 with correct
  cost badges, confirming the extended-thinking fix still holds); grepped
  the whole repo for `buy.stripe.com` (zero matches, hard constraint
  intact); crawled `index.html`/`pricing.html`/`blog/`/`terms.html`/
  `privacy.html` for broken internal links (all real links resolve; the
  only 404s were Cloudflare's own email-obfuscation rewrite artifacts,
  not real links in the source).
  **Result: zero code bugs found** — signup, chat, schema, and edge
  functions are all clean. But the sitemap-vs-nav diff (checking what
  `sitemap.xml` lists against what `index.html` actually links to, which
  no prior sweep had done) surfaced two real, previously-undocumented
  findings, both written up in "Pending / not yet applied" above rather
  than acted on unilaterally, since both need a human product call: (1)
  four live, sitemap-indexed pages (`/marketplace/`, `/builder/`,
  `/community/`, `/contractors.html`) pitching a completely different
  per-vertical local-agent-software product line, totally unlinked from
  the real site; (2) a fully-built, working, but completely orphaned
  in-app forum at `app/community.html` (real tables, real RLS, zero
  usage) that the site's actual "Community" links bypass in favor of
  Discord. Diagnostic cleanup: `test-admin-setup` was redeployed for the
  smoke test and re-stubbed to 410 immediately after, confirmed via a
  live curl.
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
- ~~P0: **Fabricated testimonials.** The three landing-page quotes ("Alex M."
  CTO, "Rachel T." consultant, "Sami K." platform engineer) are invented,
  detailed personas, not real users. Needs real quotes or removal.~~ — **fixed
  2026-09-28**, see the recent-work-log entry below (PR #96): removed rather
  than replaced, since there's no real customer base yet to draw honest
  quotes from.
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
