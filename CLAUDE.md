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
- **The `apply_migration` tool stamps `schema_migrations.version` with the
  call's own real timestamp — completely independent of whatever
  filename a migration is later committed under.** This is the root
  cause of a long-standing, just-reconciled (2026-10-09, see
  recent-work-log) drift between this repo's `supabase/migrations/`
  files and what Supabase's own migration-history table actually
  tracks: every migration in this project's history was applied via
  this tool (not the Supabase CLI's `db push`), so its *real* tracked
  version has never matched its local filename's timestamp. Harmless by
  itself (the live schema is still correct either way), but it means
  `supabase db push` — including this project's own
  `deploy-supabase.yml` CI workflow — will refuse to run while any
  version mismatch exists, since it can't tell a real gap from a
  harmless renaming apart without a human/agent checking. **Going
  forward, prefer applying migrations the way CI does (a real
  `supabase db push`, or at minimum naming migration files to match
  immediately after an `apply_migration` call by checking
  `list_migrations` for the version it was just assigned)** rather than
  letting local filenames drift from the live-tracked version again —
  the 2026-10-09 reconciliation was a large, forensic, multi-hour fix
  for exactly this pattern repeating unchecked for over a month.

## Pending / not yet applied

~~- The remote Supabase migration-history table and this repo's
  `supabase/migrations/` folder had never been in CLI-sync~~ — **fully
  reconciled 2026-10-09**, see the recent-work-log entry below for the
  complete breakdown (38 renames, 26 backfilled files, 2 real schema
  fixes for previously-broken live features, 16 bookkeeping-only
  "applied" markers). `supabase/migrations/` and the remote
  `schema_migrations` table are now a confirmed, verified, exact 1:1
  match — zero drift either direction.

~~- `user_integrations.access_token` was stored as plaintext server-side~~
  — **fixed 2026-10-09**, see the recent-work-log entry below. The column
  is now `bytea`, holding `pgp_sym_encrypt` output; `connector-proxy` reads
  and writes it only through `store_integration_token()`/
  `get_integration_token()`, never a direct column select/upsert.

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

## CI/CD

- **Frontend**: Cloudflare Workers auto-deploys on every `git push` to
  `main` — unchanged, no CI involvement.
- **Supabase backend** (`.github/workflows/deploy-supabase.yml`, added
  2026-10-09): every push to `main` touching `supabase/**` runs
  `supabase db push` (apply pending migrations — idempotent, safe to run
  on every matching push) then `supabase functions deploy` (redeploys
  **all** committed edge functions, unconditionally — not a diff of which
  changed). Deploying everything every time is deliberate: it's simpler,
  and it's the only way a change to a `_shared/` module (e.g.
  `_shared/packs.ts`) correctly reaches every function that imports it.
  This closes the exact gap that caused the PR #97 auto-model-routing
  regression (committed source correct, live function silently stale for
  days — see the 2026-09-28 recent-work-log entry below) — a merge that
  only touches git history is no longer a different thing from a deploy.
  **Requires a `SUPABASE_ACCESS_TOKEN` repo secret** (Settings → Secrets
  and variables → Actions → New repository secret) — a personal access
  token generated at https://supabase.com/dashboard/account/tokens with
  at least the scope to manage this project
  (`uzmdqbtflcpikjdrggqc`/"SovereignNation"). This is a manual, one-time
  step only a human with dashboard access can do; no MCP tool or edge
  function can generate it. Until that secret exists, this workflow's
  runs will fail at the `supabase link` step — that's expected, not a
  bug in the workflow itself, and doesn't block the frontend's own
  auto-deploy (which is entirely separate).
  `supabase/config.toml` (added same day) is what makes
  `supabase functions deploy` deploy every function with its correct
  `verify_jwt` setting instead of the CLI's/API's own `true` default —
  pulled live from `list_edge_functions` on 2026-10-09 for all 24
  committed functions. If a function's `verify_jwt` is ever changed live
  (e.g. via the dashboard), update this file in the same change or the
  next CI deploy will silently revert it.
- **Pack-config consistency check** (`.github/workflows/pack-config-check.yml`
  + `.github/scripts/check-pack-config.mjs`, added 2026-10-09): runs on
  every PR touching `pack-config.js` or
  `supabase/functions/_shared/packs.ts`, fails the build if a pack's
  price or credit amount differs between the two. See "Credit-pack
  pricing: single source of truth" below for why these two files exist
  and what this check does and doesn't cover.
- **Self-healing ceiling, by design**: both workflows stop at "detect
  drift / keep deploys current" — neither auto-merges a PR or
  auto-fixes a mismatch. That's intentional for a payments-adjacent app;
  see `site-guardian`'s own hard boundary ("never auto-merge, never ship
  an unverified fix") for the same reasoning applied the same way here.

## Credit-pack pricing: single source of truth

Pack price/credits data was hardcoded in 6 separate places before
2026-10-09 (`buy-credits`, `auto-topup-charge`, `setup-auto-topup`,
`index.html`, `pricing.html`, `app/dashboard.html`'s `PACK_LABELS`) — the
same duplication that caused the real Pro/Power naming-swap bug fixed in
PR #149 (2026-10-08) was still fully possible to repeat. Centralized into:

- **`supabase/functions/_shared/packs.ts`** — backend source of truth
  (`priceId`, `credits`, `cents` per pack key). Imported by `buy-credits`,
  `auto-topup-charge`, `setup-auto-topup`. If you add/change a pack here,
  a real Stripe Price must exist first (Stripe Prices are immutable — a
  price change is always a new Price object, never an edit).
- **`/pack-config.js`** (repo root) — frontend source of truth (`label`,
  `price`, `credits`, `note` per pack key; no `priceId`, since that's
  server-only). Loaded by `index.html`, `pricing.html`, and
  `app/dashboard.html`. `dashboard.html`'s `CREDIT_PACKS`/`PACK_LABELS`
  are now derived from `window.AETHYRO_PACKS` at runtime rather than
  separately hardcoded. `index.html`/`pricing.html` load the script for
  future-proofing but still render their pricing cards as static markup —
  not a full data-driven re-render, since that would have been a bigger
  change than what was asked.
- The two files are **not** auto-synced — `pack-config.js` has no
  `priceId`, so it can't just import from the backend file, and a shared
  module importable from both a Deno edge function and a browser `<script
  src>` tag isn't a clean fit for this codebase's no-build-step
  architecture. Instead, the pack-config-check CI job (above) catches
  drift between them on every relevant PR.
- **Found and fixed the same bug class while building this**: `index.html`
  called the $10/600cr pack "Value" in 5 places while `pricing.html` and
  `app/dashboard.html` both already said "Standard" — same root cause as
  the Pro/Power swap, just not yet caught. Made "Standard" canonical
  (2 of 3 surfaces already agreed; `dashboard.html` shows real purchase
  history, the highest-stakes surface) and fixed `index.html`'s 5
  references.

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

- **2026-10-09** — **Added a hero-image polish pass (code-drawn, not a raster
  image) and an ongoing real-testimonial collection mechanism**, both from
  the same conversation. The hero piece: generated 3 AI hero-art candidates
  via Canva for the homepage's `.hero` section, picked one ("horizon of
  light" — a bright line cutting across the dark hero, fading out toward
  the left third so it never competes with the headline), then hit a real
  blocker integrating it — the generated image was only retrievable through
  the available tooling at **199×112px** (a chat-preview thumbnail), with no
  MCP path to a production-resolution version of a bare generated image (as
  opposed to a full Canva *design*, which can be exported at any size).
  Recreated the same effect directly in CSS instead of waiting on a manual
  high-res download (`.hero-horizon`/`.horizon-line`/`.horizon-node`/
  `.horizon-wash` in `index.html`) — infinitely crisp at any size, and
  actually more consistent with this page's existing zero-`<img>`-tag,
  code-drawn-glow conventions (`.hero-orb`, `#agentCanvas`) than introducing
  a raster asset would have been. PR #157, merged by the user directly.
  **Testimonial collection**: after manually pulling real engagement data
  and personally drafting outreach to the 3-4 users who'd actually returned
  on a second day, built the repeatable version. New `testimonials` table
  (same zero-policy, RPC-only posture as `admin_users`/`agent_missions` —
  `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, one row per user ever
  via a `UNIQUE(user_id)` constraint) plus 4 `SECURITY DEFINER` RPCs:
  `request_testimonial_if_eligible` (service-role-only; `chat`'s
  `finalize()` now calls this after the low-credit/auto-topup block — fires
  at most once ever per user, the first time they cross 10+ messages or
  return on a 2nd distinct calendar day, atomically via `ON CONFLICT
  (user_id) DO NOTHING` so a race between near-simultaneous chat completions
  can't double-fire), `submit_testimonial_response` (idempotent — a second
  submit on an already-used token is a no-op, never an overwrite),
  `check_testimonial_token` (lets the public form show "invalid"/
  "already used" on load without a throwaway submit attempt), and
  `get_testimonials`/`moderate_testimonial` (both `is_admin()`-gated, same
  pattern as `get_agent_missions`). Two new edge functions:
  `send-testimonial-request` (internal-only, `X-Internal-Key`, same shape as
  `send-low-credit-email` — sends the actual ask email via Resend) and
  `submit-testimonial` (public, `verify_jwt:false`, token-authenticated —
  `GET ?token=` checks validity, `POST` records the response). New public
  `app/feedback.html` — a simple, unauthenticated form reached via the
  emailed link, no Supabase session required. New "Reviews" panel in
  `app/admin.html` (mirrors the existing Team panel's exact structure:
  4 KPI cards, a pending-review table with Approve/Reject buttons, a
  decided-history table) — approving a testimonial here never auto-publishes
  it to the live site; that's still a deliberate, separate, manual
  copy-into-`index.html` step, same as every real testimonial this project
  has ever shown, keeping the hard no-fabrication rule from the 2026-09-28
  testimonials removal intact for anything automated.
  **Found and fixed a real bug during build, before it ever reached a real
  user**: `request_testimonial_if_eligible`'s `SET search_path TO 'public'`
  excluded the `extensions` schema, where this project's `pgcrypto`
  actually lives (`gen_random_bytes`/`hmac` — same root cause
  `generation_receipts`/`deletion_receipts` already had to work around) —
  caught immediately via a direct-SQL test before any live traffic hit it,
  fixed with a follow-up migration schema-qualifying the call
  (`extensions.gen_random_bytes`) and widening the function's search_path,
  exactly the pattern `20261005224659_generation_receipts.sql` already
  established for the same reason.
  **Verified live end-to-end**, not just code review: direct-SQL tests
  (rolled back, not committed) proved the eligibility RPC's three branches
  (eligible → real token; already-asked → `false`; zero-message user →
  `false`) and the full admin moderation path under a simulated real-admin
  JWT (`get_testimonials`/`moderate_testimonial`, plus a simulated non-admin
  correctly raising `Forbidden`). Then a real, live, end-to-end pass with
  two real throwaway accounts (`test-admin-setup`, redeployed for this
  verification and re-stubbed to 410 after): one seeded to satisfy the
  2-distinct-days path, one the 10+-messages path — real `chat` API calls
  (not synthetic) correctly fired `request_testimonial_if_eligible` and
  created real `testimonials` rows with real tokens; the real
  `submit-testimonial` function correctly validated a fresh token, accepted
  a real submission, then correctly blocked and didn't overwrite on a
  resubmit attempt with the same token. Client-side (`app/feedback.html`)
  verified via Playwright with the network layer mocked (direct calls to
  the real Supabase endpoint from this sandbox's headless Chromium hit the
  same pre-existing `ERR_CERT_AUTHORITY_INVALID` proxy artifact already
  documented elsewhere in this file, not a bug in the page) — all 6 UI
  states (valid/invalid/already-used token, successful submit, no-token
  param, and empty-content blocked by the native HTML5 `required`
  attribute) rendered correctly. All three edge functions (`chat`,
  `send-testimonial-request`, `submit-testimonial`) fetched back via
  `get_edge_function` and diffed byte-for-byte against local disk (caught
  and fixed one cosmetic-only mismatch in `chat/index.ts` — a few box-
  drawing divider characters drifted during manual deploy-payload
  transcription; zero functional difference, local disk now written to
  match live exactly). Cleaned up: both throwaway accounts deleted,
  confirmed zero orphaned rows across `testimonials`/`conversations`/
  `messages`/`auth.users`, `test-admin-setup` re-stubbed to 410 and
  confirmed via a live curl. `supabase/config.toml` updated with both new
  functions' `verify_jwt:false` entries. `chat` now at v51 (comment
  header)/v53 (Supabase's internal deploy counter).
- **2026-10-09** — **Fully reconciled the migration-history drift found
  earlier the same day** (see the two entries directly below), after the
  user asked what to do next and picked this over continuing the
  self-healing roadmap. This was NOT a simple rename job — forensic
  comparison against the real SQL in `supabase_migrations.schema_migrations`
  (pulled directly via `execute_sql`, not just version numbers via
  `list_migrations`) surfaced two genuinely serious, previously-
  undocumented live bugs mixed in with the bookkeeping mismatch.
  **Found and fixed two real, live, currently-broken features**:
  `newsletter_reactions` (table + `add_newsletter_reaction()` RPC,
  committed as `20260922000001_newsletter_reactions.sql`) and
  `conversations.share_token` (the conversation-sharing feature,
  committed as `20260926000001_conversation_sharing.sql`) were both
  **committed to the repo but never actually applied to the live
  database** — confirmed via direct schema checks (`to_regclass`,
  `information_schema.columns`) before touching anything. Both are
  wired into real, currently-shipping pages (`app/newsletter.html`'s
  reaction buttons call the RPC inside a bare `try{}catch(e){}` that
  silently swallowed every failure; `app/chat.html`'s "Share" button
  and `app/share.html` depend on `share_token` and would throw a real
  error on every use). Applied both for real via `apply_migration`,
  verified live: `newsletter_reactions_table_exists`/
  `add_newsletter_reaction_fn_count`/`share_token_col_exists` all
  flipped from absent to present, and a real anon-key curl to
  `add_newsletter_reaction` returned a genuine incrementing count (`1`)
  — not just a schema check.
  **Root cause of the drift, confirmed**: every migration applied via
  the `apply_migration` MCP tool (used throughout this project's history
  instead of the CLI) gets stamped with the *call's own real timestamp*
  as its `schema_migrations.version` — completely independent of
  whatever filename/timestamp the migration is later committed under.
  This explains the entire drift, not just a few stragglers.
  **Full reconciliation, done file-by-file, not by trusting name/fuzzy
  matching alone** — every one of the 67 originally-unmatched remote
  versions was checked against actual local file *content* (normalized
  hash first, then manual diff for anything not byte-identical):
  - **38 local files renamed** (`git mv`, content confirmed identical or
    cosmetically-different-only) to their real remote-tracked version
    number, keeping each file's own descriptive name suffix.
  - **26 new files backfilled** with the real, exact SQL pulled from
    `schema_migrations.statements` for remote versions with no adequate
    local match — including 3 genuinely pre-repo-history baseline
    migrations (`pgvector_knowledge`, `subscriptions_licenses`,
    `onboarding_emails`, May/June 2026) and a cluster of real early
    hardening migrations from Sep 20-22 that this repo's own
    `20260901000001-010` files turned out to be a **later, rewritten,
    not-byte-accurate reimplementation of** (confirmed by real content
    diffs, not assumption) — including, critically, **a materially
    different and since-superseded `get_credit_balance()`** (early
    version: `SECURITY DEFINER`, no ownership check at all; the
    `20260901000002` file's version has the ownership check and
    `SECURITY INVOKER`). Also found and backfilled the real resolution
    of the `20261003135352` version-number collision this file already
    flagged: the committed
    `20261003135352_lock_down_routine_webhooks_grants.sql` needed **no
    change at all** (its version number already coincides with a real
    tracked remote version, so `db push` already treats it as applied
    regardless of the literal content difference) — the actual gap was
    the *second* step, `20261003135419_restore_authenticated_insert_delete_routine_webhooks`,
    which had no local file and was backfilled.
  - **16 local-only versions marked "applied" via a direct
    `INSERT INTO supabase_migrations.schema_migrations`** (the SQL
    equivalent of `supabase migration repair --status applied`, run
    through `apply_migration` so the repair itself is tracked too —
    confirmed via `list_migrations` afterward) rather than renamed,
    because their content doesn't correspond 1:1 to any single remote
    version — either a combined/condensed rewrite of 2-3 real remote
    steps (`20260901000009` combines `force_revoke_get_credit_balance`
    + `get_credit_balance_security_invoker`; `20260927234300` combines
    `harden_trigger_welcome_email` + `revoke_public_execute_trigger_welcome_email`),
    or a corrected final state that superseded a less-secure
    remote-tracked first draft (`20260928040000`'s anon grant correctly
    includes the `is_public` column the remote-tracked version is
    missing; `20260928060000`'s `get_credit_balance` has the
    `SECURITY DEFINER` + ownership-revoke the remote-tracked version
    lacks) — both **verified live before trusting this**, not assumed:
    direct `pg_get_functiondef`/`has_function_privilege`/
    `information_schema.column_privileges` checks confirmed the live
    function/grant state matches the local file's (more complete,
    correct) version, not the remote-tracked (incomplete) one. Marking
    these "applied" rather than renaming means `supabase db push` will
    never try to execute their SQL for real — critical for
    `20260901000002`, since actually re-running it would have silently
    reintroduced the exact arbitrary-balance-disclosure vulnerability
    this file's own schema-gotchas section already documents being
    found and fixed on 2026-10-02/03.
  **Final verification**: a from-scratch comparison of every local
  `supabase/migrations/` version prefix against a fresh
  `list_migrations` pull confirmed an **exact 1:1 match — 86 versions
  each side, zero gaps in either direction** — and a separate pass
  confirmed no duplicate version prefixes exist locally. `db push`
  should now succeed with nothing pending on the next real run.
  **Scope note**: the one harmless leftover is a test row in
  `newsletter_reactions` (`issue_slug = '__reconciliation_test__'`) that
  couldn't be deleted due to the already-documented intermittent
  `execute_sql` DELETE-cancellation quirk (failed 3 consecutive
  attempts) — left in place since it can never match a real newsletter
  issue slug and is otherwise inert, consistent with how this exact
  quirk has been handled before in this file.
- **2026-10-09** — **First concrete step toward a self-healing site,
  from the user asking what that would take: centralized credit-pack
  pricing into a single source of truth per side (frontend/backend) and
  added the first tier of auto-deploy CI**, after an exploratory
  discussion where a 4-tier roadmap was proposed (1: auto-deploy-on-merge;
  2: scheduled unattended `site-guardian` sweeps, already exists; 3:
  pre-deploy automated testing against Supabase DB branches; 4:
  auto-rollback/canary) and the user picked "tier 1 + the pack-config CI
  check" as the first PR. Full detail on the pack-pricing centralization
  itself (and the real Value/Standard naming-drift bug found and fixed
  along the way) in "Credit-pack pricing: single source of truth" above;
  full detail on both new CI workflows and the required one-time secret
  in "CI/CD" above.
  **Explicitly scoped out, matching the roadmap's own stated ceiling**:
  no tier 2-4 work in this PR (tier 2 already exists as `site-guardian`;
  tiers 3-4 are real future work, not attempted here), and no full
  data-driven re-render of `index.html`/`pricing.html`'s pricing cards
  from `pack-config.js` (they still render static markup; only
  `dashboard.html` derives its pack UI from the shared config at
  runtime) — judged bigger scope than what was asked for this pass.
  **Verified**: all three backend functions
  (`buy-credits`→v16/v18, `auto-topup-charge`→v3, `setup-auto-topup`→v3)
  deployed live and diffed byte-for-byte against local disk; all 4 pack
  keys re-verified live post-refactor (real `checkout.stripe.com` URLs
  for all 4 via `buy-credits`/`setup-auto-topup`, `auto-topup-charge`
  verified via a temporary internal-key proxy in `test-admin-setup`
  showing `pack.cents` correctly resolving before hitting Stripe's
  real payment-method check) — zero behavior change from the
  pre-refactor hardcoded literals, `test-admin-setup` re-stubbed to 410
  after. Frontend changes verified via a locally-served copy with
  Playwright: `window.AETHYRO_PACKS` loads correctly on `index.html`/
  `pricing.html`, zero "Value" text remains anywhere, zero console
  errors; `dashboard.html`'s IIFE-scoped pack-derivation logic verified
  by running the exact derivation lines against `pack-config.js` in
  isolation and confirming byte-identical output to the original
  hardcoded `CREDIT_PACKS`/`PACK_LABELS` values (couldn't drive the real
  authenticated dashboard UI without a live Supabase session in this
  verification pass, so the logic itself was verified directly instead).
  The new `check-pack-config.mjs` CI script was test-run against both
  the real (matching) files and a deliberately-drifted scratch copy —
  passes clean on the real files, correctly fails with a clear price-
  mismatch message on the drifted copy.
  **Not yet done, blocking the auto-deploy workflow from actually
  running**: the `SUPABASE_ACCESS_TOKEN` repo secret doesn't exist yet —
  this is a manual step only a human with Supabase dashboard access can
  do (generate a personal access token at
  supabase.com/dashboard/account/tokens, add it as a GitHub repo
  secret). See "CI/CD" above for the exact steps. Until it's added, the
  deploy workflow's runs will fail at `supabase link` — expected, not a
  bug, and the frontend's own auto-deploy is unaffected either way.
- **2026-10-09** — **`site-guardian` sweep, user-requested. Swept clean —
  zero new issues found.** Full checklist run against the state left by
  PRs #150/#151 (the `user_integrations` encryption fix and the
  `cycle-001.patch` cherry-picks, both merged earlier the same day).
  `get_advisors` (security+performance): every finding matches this
  file's already-documented accepted classes — the 5 zero-policy tables
  (`admin_users`/`agent_missions`/`app_secrets`/`model_router_centroids`/
  `rate_limit_counters`), GraphQL-exposure boilerplate, the two
  intentional anon-executable `get_credit_balance()`/`is_admin()`
  functions, 12 `authenticated`-executable admin/owner-gated RPCs (each
  does its own internal `is_admin()`/ownership check), unindexed FKs,
  RLS `auth.<fn>()` re-evaluation, unused indexes, multiple permissive
  policies on 3 tables (`newsletter_issues`/`pack_content`/
  `user_routines`), and leaked-password protection still correctly
  explained by the Free plan — nothing new, `extension_in_public`
  (vector/pg_net) included, both long-installed and in active use.
  `list_edge_functions` (28) vs. `supabase/functions/` (24 committed):
  the 4-function gap is exactly the known diagnostic-stub set
  (`test-admin-setup`/`test-voyage-probe`/`test-embed-probe`/
  `test-embed-batch`), all confirmed still correctly inert — no drift.
  `pg_trigger` on `auth.users` (4, all enabled) and `pg_cron.job` (6
  jobs) both matched this file's documented baseline exactly. Live
  smoke test with two real throwaway accounts: signup produced exactly
  one `profiles`/`referral_codes`/`signup_bonus` row each (no
  regression of the old double-bonus bug); a real chat message on all
  three `MODEL_MAP` keys (haiku/sonnet/opus) succeeded with correct
  billing and a real signed generation receipt each; referral
  redemption happy (+100 credits), duplicate (409), self-referral
  (400), and invalid-code (404) paths all correct; `buy-credits`
  resolved to a real `checkout.stripe.com` URL, never a bare Stripe
  link; `user_integrations` confirmed still at 0 rows (no leftover test
  data from the same-day encryption-fix work). Hard security constraint
  re-grepped clean (zero real `buy.stripe.com` matches — only this
  file's own and `site-guardian/SKILL.md`'s negative-example mentions).
  Static pages (`/`, `/robots.txt`, `/sitemap.xml`, `/terms.html`,
  `/privacy.html`, `/trust.html`, `/developers.html`, `/routines.html`,
  `/pricing.html`) all live (200), a real unknown path still 404s.
  Re-grepped for stale subscription-model references
  (`personal`/`research`/`cpa` plan keys, live `create-checkout`
  callers) — none found. **Not completed this sweep, same as every
  prior attempt**: the edge-function error-rate log check — tried the
  same `function_edge_logs` query shape documented as working in a past
  sweep, got `Table "function_edge_logs" does not exist` again; this
  has now failed identically across at least 4 separate sweeps and is a
  standing tooling limitation, not worth retrying again without a
  different approach. Cleaned up: both throwaway accounts deleted, zero
  orphaned rows confirmed across `profiles`/`credit_ledger`/
  `referral_codes`/`referral_events`/`generation_receipts`/`auth.users`,
  `test-admin-setup` re-stubbed to 410 and confirmed via a live curl.
  No PRs needed — nothing to fix.
- **2026-10-09** — **Cherry-picked the safe items from an uploaded
  `cycle-001.patch`** (an external multi-agent "cycle" report's proposed
  diff, same provenance as the pricing-audit report behind PR #149),
  after flagging two items in it as problems rather than applying them
  wholesale: it reverted the already-verified "~13 Opus replies" figure
  to "~11 deep Opus reviews" on the Starter pack only (would have made
  the four-pack table internally inconsistent — the other three tiers
  stayed worded as plain "~Opus messages"), and it built a "For
  business"/"For developers" hero tab-split that was previously and
  explicitly deferred (2026-10-06 entry) pending the user's own
  sign-off, which this patch never obtained. Neither was applied.
  **What was applied**, confirmed safe on review: (1) `index.html`'s
  `#compare` table — "GPT-4o" → "Flagship OpenAI model*" with a new
  footnote ("*Model lineups change — checked Oct 2026.") and the same
  change to `pricing.html`'s comparison table, since a competitor's
  current model name is the kind of fact that goes stale silently; (2)
  `index.html`'s `#compare` table "Credits that never expire" row —
  bare "✗" → "n/a — no credit packs" for both competitor columns, since
  neither has a credit-pack concept at all, matching how
  `pricing.html`'s equivalent table already uses "— N/A" for the same
  reason (this project's own established non-overclaiming convention,
  `index.html` was just the one lagging); same fix applied to "Free
  credits on signup"'s ChatGPT Plus cell ("✗" → "n/a" — Claude.ai Pro's
  "Limited trial" cell was left as-is, it's a real answer not a cross);
  (3) softened `index.html`'s "How it works" section — "60 seconds" →
  "about a minute", "Create an account in 10 seconds" → "...in under a
  minute" (neither speed claim was ever independently verified, and the
  vaguer framing costs nothing).
  Verified via a locally-served copy with Playwright: both new copy
  strings and all 4 table-cell changes render correctly, zero horizontal
  overflow, zero console errors; JSON-LD blocks in both files
  re-validated as parseable JSON and all inline `<script>` blocks in
  both files re-checked with `node --check` after editing.
- **2026-10-09** — **Encrypted `user_integrations.access_token` at rest**,
  closing the real gap flagged in "Pending" on 2026-10-08: the column's
  own migration comment always said `-- stored as-is (PAT or API key);
  encrypt at app layer`, but that encryption was never actually built.
  Confirmed live before changing anything: the table has 0 rows (nobody
  has ever connected GitHub/Notion), and — a second, separate,
  previously-undocumented finding — `authenticated` had full `SELECT`/
  `INSERT`/`UPDATE`/`DELETE` table-level grants on `user_integrations`
  (the same default-privileges-grant-is-a-floor pattern this file already
  documents for `api_keys`/`routine_webhooks`/`agent_missions`), meaning
  a signed-in user could already read their own raw plaintext token
  directly via REST, bypassing both the service-role-only design and the
  `connect` action's real-token-validation step.
  Migration `20261009000000_encrypt_integration_tokens.sql`: seeds a new
  `app_secrets` key (`integration_token_encryption_key`, same zero-policy
  pattern as the deletion/generation-receipt HMAC keys), `REVOKE ALL ...
  FROM anon, authenticated` on the table, converts `access_token` from
  `text` to `bytea` holding `pgp_sym_encrypt` output, and adds two new
  `SECURITY DEFINER` RPCs — `store_integration_token`/
  `get_integration_token` — gated on `auth.role() = 'service_role'` (not
  `auth.uid() = p_user_id`, deliberately: this function's only legitimate
  caller is `connector-proxy`'s own service-role client, which has
  already resolved the real user from their own JWT before calling it —
  the exact `get_credit_balance` lesson this file already documents,
  applied up front this time instead of discovered after the fact).
  **Real obstacle hit and fixed**: the first version of the migration's
  `ALTER COLUMN access_token TYPE bytea USING (...)` tried to look the
  encryption key up with a subquery
  (`(SELECT value FROM app_secrets WHERE key = ...)`) directly inside the
  `USING` clause — Postgres rejects this (`0A000: cannot use subquery in
  transform expression`), since a `USING` transform expression disallows
  subqueries even though an ordinary `UPDATE ... SET` allows them freely.
  Fixed by fetching the key into a transaction-local GUC first
  (`set_config('aethyro.tmp_integration_key', v_key, false)` inside a
  `DO $$ ... $$` block) and reading it back via `current_setting(...)` —
  a plain function call, not a subquery — inside the `USING` clause.
  `supabase/functions/connector-proxy/index.ts` (now v2): `connect` calls
  `store_integration_token` instead of upserting `access_token` directly;
  `query` calls `get_integration_token` instead of selecting it — the
  plaintext token now only ever exists transiently in the function's own
  memory, decrypted server-side per request, never read from the column
  directly by this function's code.
  **Verified live, not just by reading the migration**: `has_table_privilege`/
  `has_function_privilege` confirmed `anon`/`authenticated` both `false`
  on the table and on both new RPCs, `service_role` `true` on both RPCs;
  a direct SQL round-trip (`store_integration_token` → raw bytes contain
  no trace of the plaintext, in both raw and hex form → `get_integration_token`
  → exact original plaintext back) proved the encryption actually works,
  not just that the migration applied; a non-service-role call correctly
  raised `Forbidden`. End-to-end via real HTTP with a throwaway account:
  `query` with nothing connected correctly 404s; after seeding a fake
  token via the RPC, `list_integrations` showed it correctly and `query`
  reached the real GitHub API with the *decrypted* token (GitHub's own
  `401 Bad credentials` for the fake value — proving decryption succeeded
  through the full HTTP path, not just via direct SQL, since a decryption
  failure would have surfaced as a 500 from inside `get_integration_token`
  instead); `disconnect` cleanly removed the row; a raw REST `SELECT
  access_token` as the signed-in user now 404s with "Could not find the
  table" — PostgREST hides a table from its schema cache entirely once no
  role has any grant on it, an even stronger result than a plain 403.
  Live `connector-proxy` source fetched back via `get_edge_function` and
  diffed byte-for-byte against local disk. Cleaned up: the throwaway
  account and its one test row deleted via a direct call to its own
  `disconnect` action (confirmed `list_integrations` empty after);
  `test-admin-setup` re-stubbed to 410 and confirmed via a live curl.
  **One execution-tooling quirk hit along the way, not a bug in this
  fix**: a direct `DELETE` via `execute_sql` against the real admin
  account's own synthetic test row (used for the direct-SQL round-trip
  check above) returned `{"status":"cancelled"}` on **six** consecutive
  attempts — the same intermittent quirk this file already documents for
  DELETEs/UPDATEs against this project — while an `UPDATE` neutralizing
  the row's content (`access_token = NULL`) succeeded immediately. Worked
  around by deleting the row through `connector-proxy`'s own `disconnect`
  action instead (called via a temporary edge-function helper acting as
  service role), which succeeded on the first attempt — confirming the
  flakiness is specific to the `execute_sql`/`apply_migration` DELETE
  path, not to Postgres `DELETE` itself. Worth remembering: when a direct
  SQL `DELETE` via these tools gets stuck in this loop, a service-role
  client call (an edge function, or the equivalent) is a reliable
  fallback, not just more retries.
  **Scope note**: `refresh_token` (currently unused — GitHub/Notion PATs
  need no refresh) was deliberately left as plain `text`, with a column
  comment flagging that a future provider needing it must encrypt it the
  same way. `metadata` (login/name, non-secret) was left untouched.

- **2026-10-08** — **Graded an uploaded external "pricing page audit"
  report against the live site before acting on it (same pattern as
  every other external review this project has received), and found a
  real bug the report itself didn't correctly describe.** The report's
  headline claim — a "best value" badge sits on the wrong pack — turned
  out to have the pack *names* backwards when checked against the real
  page. Digging into why surfaced the actual, worse, previously-
  undocumented bug: **the same two packs ($30/2000cr and $90/7000cr) are
  called "Pro"/"Power" on `index.html` but swapped to "Power"/"Pro" on
  `pricing.html` and in `app/dashboard.html`'s `PACK_LABELS`** — a real
  cross-page AND in-app inconsistency (a signed-in user's purchase
  history/auto-topup settings on the dashboard would show the *opposite*
  pack names from what they saw on the pricing page before buying).
  Normalized every surface to `index.html`'s convention
  (`power`=$30/2000cr, `pro_7k`=$90/7000cr), which already matches the
  backend's own Stripe/metadata key names (confirmed in
  `buy-credits/index.ts`'s `CREDIT_PACKS`) and this file's own prior
  documentation.
  **Fixed, once correctly named**: moved the "Best value" badge to the
  pack that's actually cheapest per credit ($90/7000cr = $0.0129/cr vs.
  $30/2000cr = $0.015/cr) on both `index.html` and `pricing.html` — the
  real arithmetic bug underneath the report's confused claim. Also fixed
  `pricing.html`'s JSON-LD structured data (same Pro/Power swap, plus an
  unrelated stale Starter-pack Opus-message count of 20 that should be
  13 at the site's own consistent ~15cr/message rate).
  **Two real overclaims found and fixed** while verifying the report's
  other claims: `index.html`'s "nothing/zero data stored server-side"
  for GitHub/Notion integrations was flatly false — checked
  `user_integrations.access_token` directly, and it's stored as
  plaintext server-side per its own migration comment
  (`-- stored as-is (PAT or API key); encrypt at app layer` — that
  encryption was apparently never done). Removed the false claim rather
  than leave an inaccurate security statement live; **flagging the
  plaintext-at-rest token storage itself as a separate, real, not-yet-
  fixed security gap** worth a dedicated hardening pass, not something
  silently patched inside a copy-accuracy PR. Also softened "No data
  used for training — Guaranteed" (Aethyro's own column) to "Per
  Anthropic's API policy" — Aethyro relies on, but doesn't itself
  control, that policy — and `pricing.html`'s "the world's most capable
  model" (unverifiable against every model globally) to "Anthropic's
  most capable model" (true, and matches `index.html`'s own existing
  phrasing of the same claim).
  **Checked and confirmed NOT a bug**, despite the report's "high
  confidence" framing: its claim that "~13 Opus replies" contradicts the
  page's own "~18cr deep review" example. The ~13/~40/~130/~460 Opus-
  message counts across all four packs are self-consistent at this
  site's own stated ~15cr/Opus-message rate (`pricing.html`'s model-tier
  panel literally says "~15 cr/msg" for Opus) — the 18cr figure
  describes a specifically heavier "deep review of a long doc" task on
  a separate `index.html` panel, not a contradiction once the whole site
  is read together rather than two numbers in isolation. Left unchanged.
  The report's other LOW-severity items (GPT-4o dating, ✗-as-demerit
  framing on credit rows, "10/60 seconds" puffery) were checked and
  either already correctly handled (`pricing.html`'s comparison table
  already uses "— N/A" for competitor credit rows, not a bare ✗) or too
  low-value/low-confidence to act on — skipped, consistent with this
  project's standing practice of fixing the real findings from an
  external review and explicitly declining the rest rather than fixing
  everything indiscriminately.
  **Also noted**: the report's proposed "credits never expire vs.
  monthly plans reset to zero" growth experiment is **already shipped**
  — `index.html`'s comparison table already has a "Credits that never
  expire" row with exactly this framing. Its proposed formal A/B-test
  methodology (run until ~200 completed checkouts per variant) is not
  realistic at this product's current scale — $0 lifetime purchase
  revenue — so no experiment infrastructure was built for it.
  Verified: `node --check` on every inline script in all 3 touched
  files, JSON-LD blocks in both `index.html` and `pricing.html` re-
  validated as parseable JSON after editing, and a full repo grep
  confirming no remaining "Pro"/"Power" naming mismatch anywhere else
  (`developers.html`'s mentions are generic, name no dollar amount, and
  needed no change).

- **2026-10-08** — **First real mission run through the "agent team" built
  earlier the same day (see the entry directly below): `nexus` was given
  "grow signups," re-pointed it to the real bottleneck the data showed,
  and `codex` shipped a fix.** Grounding check before dispatching anything
  found the literal goal was wrong: 42 of 46 total users signed up in the
  last 7 days (top-of-funnel is fine), but only 3/46 (6.5%) ever returned
  on a second distinct day — re-pointed the goal to that. Dispatched
  `oracle`, which found the actual mechanism, not just the symptom: the
  2026-10-06 return-visit email hook (`email_on_result` on routines) has
  had **zero possible reach** — all 45 real accounts have 0 rows in
  `user_routines`, ever, so the feature has never once had a chance to
  fire, not just "not enough time to prove out." The 3 people who did
  return weren't shallow users either (8-12 messages in their first
  session), so this isn't "tried it, didn't like it" — it's "no trigger
  to come back." Proposal: personalize the existing day-2 drip email
  (`send-welcome-email`'s `engagement` branch) with a deep-link to the
  user's own first conversation instead of generic copy.
  User approved the proposal and picked the tone ("Direct & helpful").
  Dispatched `codex`, which built it: before sending, looks up the
  user's **earliest** conversation (`id,title`, ordered by `created_at`
  asc) and personalizes with "You were asking about **[title]** — want
  to pick that back up?" linking to `${BASE_URL}/app/chat.html?c=
  ${conversationId}` (confirmed live that `chat.html` already reads
  `?c=` via `URLSearchParams` and calls `loadConversation()` — no new
  deep-link mechanism needed). Falls back to the exact original generic
  copy, byte-for-byte unchanged, on no conversation/null title/any
  lookup error — fails closed, never fabricates a topic. `welcome`/
  `reengagement` branches untouched. Deployed (`verify_jwt` checked
  first, passed explicit; live source diffed byte-for-byte against
  local disk after). **Verified live with real delivered email content,
  not just logs**: two real throwaway accounts with real AgentMail
  inboxes (so the actual delivered HTML could be read, sidestepping the
  documented `@example.com`-Resend-rejection non-bug) — one with a real
  conversation (title "Fitting a turbo intercooler on a 1998 Civic")
  got the personalized copy with a correctly-formed `?c=<real id>` link;
  one with zero conversations got the exact unchanged generic copy.
  Cleanup confirmed zero orphaned rows, both AgentMail inboxes deleted,
  `test-admin-setup` re-stubbed to 410 and confirmed via a live curl.
  Draft PR #148, not merged — left for the user to review.
  **Every mission from this run logged in `agent_missions`** (two
  `nexus` rows — the ledger-infrastructure build and this dispatch — one
  `oracle` row, one `codex` row — all `outcome:'report_only'` except the
  infrastructure build itself, which is `'merged'`), visible in
  `app/admin.html`'s Team panel. One cosmetic-only gap hit while
  recording this: the `oracle` row's `notes` field failed to persist
  after 6 retries with varying content (short/long, plain/quoted text)
  — the same intermittent `execute_sql`-mutation-cancellation quirk this
  file already documents for DELETEs, now also seen on an UPDATE;
  `outcome`/`value_tag`/`pr_url` all landed correctly on every row, this
  was purely one `notes` field, and the finding itself is still fully
  captured in the `nexus` row's own notes, so nothing was actually lost.
  **Scope note**: this is the first proof the nexus→oracle→codex loop
  actually works end-to-end (ground → dispatch → build → verify → PR),
  not a claim that retention is now fixed — PR #148 hasn't merged yet,
  and even once it does, whether it moves the real 6.5% number is
  something only real user behavior over the following days can answer,
  not this session.

- **2026-10-08** — **Built the "agent team": a real mission ledger + three
  new Claude Code skills (`nexus`, `oracle`, `support-triage`) + an admin
  Team panel**, from the user asking whether the superagent-economy
  design doc they shared (a standalone Node.js orchestrator with a
  simulated-currency "treasury", local-LLM divisions, goal/budget
  tracking) could be adapted for this site, then explicitly approving a
  reworked version and asking to "add more to enhance and advance."
  Deliberately **not** a port of that design — it would have added a
  second, weaker, disconnected LLM system with no access to this
  project's own institutional memory (this file) when the stronger,
  already-available primitive is a Claude Code skill dispatched through
  the `Agent` tool. Mapped every "division" from the shared doc onto
  something that already exists or a new skill scoped the same way:
  `sentinel`→`site-guardian`, `codex`→`backend-reviewer`, `avery`→
  `atlas-web-design`, `oracle`/`support`→two new skills (below),
  `forge`→no fixed skill, scoped `Agent`-tool dispatch for build work too
  varied to checklist, `nexus`→the new orchestrator skill itself.
  **Rejected the simulated-currency "treasury" concept outright** — a
  frontier model doesn't need bounty/budget shaping to try hard, and
  fabricating a fake economy metric for a product that already has a
  hard-learned, repeatedly-enforced anti-fabrication policy (testimonials
  removal, routines-gallery "Starter ideas" disclaimer, the explicitly-
  labeled pricing example) would have been a direct contradiction of it.
  Built the honest version instead: a real Supabase ledger table,
  `agent_missions` (`division` CHECK'd to the 7 role names, `goal`,
  `scope`, `pr_url`, `outcome` CHECK'd to `in_progress/merged/closed/
  rejected/escalated/report_only`, `value_tag`, `notes`), following this
  project's own established zero-policy-table + `is_admin()`-gated
  `SECURITY DEFINER` RPC pattern exactly (`20260927020000_admin_users_table.sql`
  is the template) — `REVOKE ALL ... FROM PUBLIC, anon, authenticated` on
  the table itself (no client write path exists at all; a mission is only
  ever written via this session's own direct Supabase/SQL access, by
  design — see the migration's own comment), and `get_agent_missions(int)`
  revoked from `PUBLIC`/`anon`, granted to `authenticated` only, with the
  usual `IF NOT is_admin() THEN RAISE EXCEPTION 'Forbidden'` gate inside.
  Migration: `20261008211500_agent_missions_ledger.sql`.
  **New skills**: `nexus` (orchestrator — grounds a goal in real data,
  decomposes it into scoped per-division subtasks, dispatches each via
  the `Agent` tool, records every mission in the ledger); `oracle`
  (growth/data strategy — pulls real usage numbers before recommending
  anything, same anti-fabrication discipline, explicitly distinguishes a
  real statistic from a labeled illustrative example); `support-triage`
  (root-causes one real user report the way the Dj/Lee chat-quality
  investigation two entries below was actually done — pull their real
  `messages`/`credit_ledger` history first, root-cause in code, fix or
  escalate, never guess from the paraphrase alone). All three carry the
  same hard boundaries as every other automated role in this repo: never
  merge own PR, never push to `main`, never fabricate a metric/
  testimonial, never contact a real customer directly.
  **New `app/admin.html` "Team" panel**: sidebar nav item, `#section-team`
  (4 KPI cards — missions logged, merged, rejected/closed, divisions
  active — a by-division breakdown table, a recent-missions table with
  outcome badges and PR links), `loadTeam()` calling
  `sb.rpc('get_agent_missions', {p_limit: 50})`, wired into
  `SECTION_LABELS`/`showSection()`/`refreshCurrent()` exactly like the
  existing Overview/Users/Drip/Credits sections. Shows an honest empty
  state ("No missions logged yet") rather than any fabricated activity —
  deliberately not a public-facing dashboard, since nothing about this is
  meant to look like real traction to anyone but the person running the
  project.
  **Verified live**: `has_table_privilege`/`has_function_privilege`
  checked directly (not inferred from the migration text) — `anon`/
  `authenticated` both `false` on every `agent_missions` table privilege,
  `authenticated` correctly `true` and `anon` correctly `false` on
  `get_agent_missions(int)`, `service_role` `true`. Called the RPC twice
  under a simulated JWT via `set_config('request.jwt.claims', ...)` +
  `SET LOCAL ROLE authenticated`: the real admin's `sub` correctly
  returned real data, a random non-admin `sub` correctly raised
  `Forbidden`. Seeded one real mission row for this build itself
  (`division:'nexus'`, `outcome:'in_progress'`) rather than leaving the
  ledger's first-ever read empty or backfilling fake history — will
  update to `merged` with the real PR URL once it lands. `node --check`
  on `app/admin.html`'s inline script, clean.
  **Scope note**: this is infrastructure only — no division has been
  dispatched on a real goal yet through `nexus`. The next natural step is
  giving `nexus` an actual goal to decompose, not building further
  plumbing.

- **2026-10-08** — **Made `chat`'s `model:"auto"` routing and system prompt
  "more intelligent"** after a direct user complaint about a real exchange:
  Dj (see the two entries directly below) asked a detailed car-parts-fitment
  question (fitting a specific Holley intake manifold + elbow under a VFN
  fiberglass hood while keeping factory wipers), and after several
  substantive follow-ups the assistant was still asking circular clarifying
  questions and ended on "go borrow/source a hood to test-fit it" — useless
  advice to someone who'd just said they don't have a hood and are trying to
  decide whether to buy one. Pulled the actual conversation from
  `messages`/`credit_ledger` (not just the user's paraphrase) to root-cause
  it rather than guessing: 3 of the 4 exchanges were billed to **Haiku**, the
  cheapest/weakest model, despite being deep into a genuinely hard technical
  thread. Root cause: `classifyModelFromEmbedding()` only ever embeds the
  **current** message — it has zero visibility into `historyRaw`, which is
  already sitting in memory at that point in the handler. A short,
  substantive reply mid-thread ("i dont have a hood", 19 chars) reads as
  trivially "light" in isolation even though the conversation it's part of
  is anything but.
  **Two fixes, `chat` now v50**: (1) a new floor — when `model:"auto"`
  classifies a message as `haiku` AND `historyRaw.length > 0` (an ongoing
  conversation, not a fresh one) AND the message doesn't match
  `AUTO_LIGHT_RE` (a genuine trivial acknowledgment like "thanks!"), bump it
  to `sonnet`. Zero added latency or DB calls — `historyRaw` is already
  parsed from the request body. (2) `systemPrompt` now explicitly instructs
  the model to lead with a decisive, concrete recommendation rather than
  re-asking a question the user has effectively already answered, and the
  `web_search` tool's guidance (both in `systemPrompt` and the tool's own
  `description`) was broadened from just "time-sensitive" topics to cover
  any specific real-world product/part/compatibility question where actual
  documented data (specs, forum reports) would beat generic reasoning —
  search before telling a user to go acquire or physically test something
  just to find out.
  **Verified live end-to-end** with a real throwaway account, replaying the
  exact failure shape: turn 1 (the opening fitment question, no history) —
  even on Haiku, the new system prompt alone produced a decisive "**No, not
  realistically**" with concrete numbers (2-4", 5-6"+) instead of the old
  hedging; turn 2 (the short "i dont have a hood" follow-up, with real
  history attached) — correctly routed to **Sonnet** (confirmed via the raw
  `cost.model` field in `USAGE_MARK`), producing a genuinely reasoned answer
  (realizing hood clearance and wiper-motor clearance are independent
  constraints) ending in actionable advice ("mock this up with cardboard/
  foam before spending money on the elbow") instead of "go get a part to
  test"; turn 3 (a genuine "thanks!" in the same thread) correctly stayed on
  **Haiku** — confirming the floor doesn't regress the auto-router's whole
  cost-saving point for actual trivial acknowledgments. Live source fetched
  back via `get_edge_function` and diffed byte-for-byte against local disk
  (caught and fixed, in the same pass, that the v49 "(no response)" fix's
  header comment had never actually been synced back to local disk from an
  earlier session — local disk is now byte-for-byte current with live for
  the first time in a while). Cleaned up: deleted the throwaway account
  (confirmed real billing rows existed, zero orphaned `conversations` since
  this test called the API directly rather than through `chat.html`),
  `test-admin-setup` re-stubbed to 410 and confirmed via a live curl (401 at
  the gateway).
  **Scope note**: only `chat`'s `model:"auto"` path is affected — an
  explicit model choice is untouched, same asymmetric-safety-net posture as
  every other auto-router adjustment in this file. `api-chat` has its own,
  simpler system prompt with no `web_search` tool at all (by design, see
  `developers.html`'s known gaps) and wasn't touched; `trial-chat`'s prompt
  is deliberately short-preview-only and has no `web_search` either, so
  neither fix applies there.

- **2026-10-08** — **Granted a real user ("Dj", `lee947204@gmail.com`, user_id
  `9dda3dd8-6669-4555-88fa-2a9c7ca53e28`) 100 goodwill credits** for the
  "(no response)" inconvenience (see the fix entry directly below) — his
  balance went 195 → 295. Looking him up by email first surfaced something
  worth recording: his real conversation (6 exchanges, all billed, all with
  real saved replies) shows the "(no response)" he hit never happened on
  the authenticated path — it only shows up server-side on an empty
  completion, and `chat.html` never persists an empty reply to `messages`
  at all, so there's no trace of a failed exchange anywhere in his signed-in
  history. He almost certainly hit it on the anonymous free-trial path
  (`trial-chat`, which keeps no DB record at all) before signing up.
  **Found and fixed a second, real, previously-undocumented bug going to
  grant this**: `admin_adjust_credits` (the RPC `app/admin.html`'s credit-
  adjustment panel calls) has been **completely broken since it was
  written** — it inserts `reason: 'admin:' || p_reason` (e.g.
  `'admin:manual adjustment'`), but `credit_ledger_reason_check` only
  allows a fixed set of bare literals (`purchase`, `chat_usage`,
  `signup_bonus`, `admin_adjustment`, `referral_bonus`, `routine`,
  `agent_task`, `api_usage`) — every single call has always raised a
  `23514` check-constraint violation and aborted before `RETURN`, with no
  caller ever around to surface it until now. Same root-cause class this
  file already documents multiple times (run-routines/run-agent-task
  billing) — a `reason` value that doesn't literally match the CHECK
  constraint. Confirmed the `is_admin()` auth gate itself was already
  correctly fixed by `20260927020000_admin_users_table.sql` (that part
  was fine); only the reason-format bug was new. Fixed with
  `20261008190000_fix_admin_adjust_credits_reason_format.sql` — now
  inserts the bare `'admin_adjustment'` literal and moves the human-
  readable reason into `metadata.note`, matching how every other ledger
  row in this schema separates its strict-enum `reason` from free-text
  `metadata`. Checked `app/admin.html` and `app/dashboard.html` before
  shipping: the admin panel just passes `p_reason` through (no client-side
  parsing of the stored string), and the dashboard's credit-history
  `REASON_LABELS` map already has a correct `admin_adjustment: 'Admin
  adjustment'` entry — zero client changes needed either way. Applied
  live via `apply_migration`, then verified the new INSERT shape succeeds
  against the live CHECK constraint by using it directly for Dj's actual
  grant (not a separate throwaway test — the real goodwill credit *is*
  the live verification). **Dormant bug, not yet used for anything real**:
  zero rows in `credit_ledger` had `reason` starting with `'admin:'`
  before this fix, confirming the admin credit-adjust feature has never
  actually been used successfully on this project, by anyone, until Dj's
  grant just now.

- **2026-10-08** — **Fixed a real live bug: a user ("Dj") reported chat.html
  showing "(no response)" twice in a row on an unusual/garbled message.**
  Traced from a screenshot, not just a description — the pill text matched
  `app/chat.html`'s own dead-end fallback (`bubble.textContent='(no
  response)'`), which fires when the stream completes with zero HTTP error
  but the accumulated reply text (`full`) ends up empty. Root-caused in
  both edge functions that can produce this:
  - **`trial-chat`** only ever set an explanatory `error` field when
    `stop_reason === "refusal"` literally — any other stop reason (e.g.
    `"end_turn"`) with zero `text_delta` events fell straight through to
    the client's generic fallback with no explanation. Broadened the check
    to any empty final text, regardless of `stop_reason`.
  - **`chat` (authenticated) was worse: `finalize()` never sent an `error`
    field in its USAGE_MARK JSON at all**, for any reason — meaning a
    signed-in user hitting a refusal, or extended thinking's 8192-token
    budget running out before the model ever reached a `text_delta` chunk
    (the thinking content is only ever flushed to the client on the FIRST
    text_delta — if none comes, the client gets literally zero bytes), got
    "(no response)" **after still being billed at least 1 credit**, with
    no way to know why. `finalize()` now takes a `stopReason` param and
    includes an explicit, stop-reason-aware `error` message
    ("declined to answer" / "ran out of room thinking that one through,
    try asking more directly or splitting it up" / generic rephrase
    prompt); the main streaming branch also flushes `thinkingText` via
    `THINK_MARK` if the budget ran out before `thinkingEmitted` ever
    fired, so the reasoning panel shows instead of nothing.
  - **Separate, confirmed-reproducible bug found live while investigating**:
    `trial-chat`'s 400-token cap can cut a real, substantive answer off
    mid-word with zero indication to the user it was truncated rather than
    the model just stopping (reproduced live: a real answer ended
    `"...If you're after something adj"`). Added a visible note
    (`*(cut short — this is the free preview; sign up for full-length
    answers)*`) appended to the stream when `stop_reason === "max_tokens"`
    on a non-empty reply.
  - `app/chat.html`'s last-resort `(no response)` fallback (for any future
    gap that still slips past both server-side checks) was hardened to an
    actionable message instead of a dead end.
  **Verified live** with a real throwaway account: a normal message still
  returns `error: null` and bills/receipts correctly (no regression,
  confirmed by parsing the raw USAGE_MARK JSON directly, not just visual
  inspection); a reconstructed version of the reported garbled prompt
  against `model:"opus"` (to engage extended thinking) returned a real,
  non-empty reply this run — expected, since the underlying empty-response
  case is inherently non-deterministic LLM behavior, not something a curl
  replay can force on demand; the fix is in the code path regardless and
  will catch it next time it happens. Both functions' live source fetched
  back via `get_edge_function` and diffed byte-for-byte against local disk
  before trusting either deploy (`chat` now v49, `trial-chat` v16, both
  deployed with their pre-existing `verify_jwt` passed explicit). Cleaned
  up: deleted the throwaway account (zero orphaned rows confirmed across
  `profiles`/`credit_ledger`/`generation_receipts`/`auth.users`),
  `test-admin-setup` re-stubbed to 410 and confirmed via a live curl.
  **What this does NOT establish**: whether Dj's exact message hit the
  refusal path or the thinking-budget-exhaustion path specifically — both
  are now covered either way, and both previously produced the identical
  symptom with zero way to tell them apart, which is itself part of what
  this fix closes.

- **2026-10-08** — **Graded a pasted NotebookLM-generated strategic roadmap
  against the live site/DB (same fact-check-before-acting pattern as the
  homepage-feedback review below), then built the 3 items that survived
  the check.** The roadmap (built from the public-page source list given
  to the user for their own NotebookLM session) got one recommendation
  flatly wrong — "Introduce Optional Auto Top-Up" — because auto-topup
  already shipped live in PR #99 (2026-09-28); its public sources, being
  logged-out marketing pages, have no way to see a `dashboard.html`-only
  feature. Two more were real, correctly-scoped gaps, confirmed live
  before building: `select count(*) from user_routines where is_public =
  true` returned 0 (the community gallery had zero real public routines,
  only the 4 hardcoded "Starter ideas"), and `developers.html`'s own
  "known v1 gaps" card already documented `api-chat` as having no
  streaming and no `auto` routing. Built both, plus linked `/trust.html`
  from the auth pages (the roadmap's "promote privacy differentiators on
  signup" ask) since it was a 10-minute addition in the same pass. Also
  caught, not from the DB but by re-reading the roadmap's own numbers:
  it stated the Power/Pro pack prices backwards ("Pro ($30) or Power
  ($90)" — the real pricing, confirmed in `index.html`'s FAQ and this
  file, is Power=$30/2000cr, Pro=$90/7000cr) — a correction given back to
  the user in chat, not something to fix in this repo since the error
  lived in the roadmap document, not in any Aethyro source.
  **(1) Seeded the community routines gallery** with 12 real template
  routines (migration `20261008160000_seed_official_routine_templates.sql`),
  owned by the admin account, spanning planning/writing/code-review/
  interview-prep/learning/journaling tasks. All 12 land `enabled = false`
  — confirmed via `run-routines/index.ts`'s own `where enabled = true`
  query that this makes them structurally unable to ever run or bill the
  admin's credits; they exist only to be read (`routines_public_read` RLS)
  and forked (`fork_routine()`, which already lands forks `enabled =
  false` too). Written as single-shot generative/drafting tasks, not
  "fetch today's X" tasks — confirmed by reading `run-routines/index.ts`
  that it has no `TOOLS` array at all (no `web_search`, unlike `chat`),
  so a routine that assumed live data access would silently return stale
  guesses. Verified live: anon-key REST call matching `routines.html`'s
  exact query (`is_public=eq.true`, `order=fork_count.desc`) returned 3
  real seeded templates — confirms the `20260928040000` anon-grant
  migration still correctly serves new rows with no further grant
  changes needed.
  **(2) `api-chat` v4** — added `model:"auto"` (reuses `chat/index.ts`'s
  embedding classifier — `classify_router_tier()` RPC + the same
  `AUTO_HEAVY_SIGNALS`/length-heuristic fallback — copied deliberately
  close to verbatim so a developer gets the same routing behavior as
  chat.html, not a second, silently-different auto-router), `stream:true`
  (standard SSE `data: {...}\n\n` framing + `data: [DONE]`, not
  chat.html's internal marker-byte protocol — this is a public API for
  arbitrary external clients, so it uses the conventional shape instead),
  and a lifetime-purchase rate-limit tier (90 req/min instead of the
  default 30, for any account with a real `credit_ledger` row
  `reason='purchase'` and `metadata->>credit_pack` of `power` or
  `pro_7k` — a one-time-purchase check, not a subscription-tier check,
  since this product has no subscriptions). Deployed with `verify_jwt:
  false` passed explicit (per this file's own established gotcha), live
  source fetched back and diffed byte-for-byte against local disk.
  **Verified live end-to-end** with a real throwaway account + a real
  API key (via `create_api_key`): explicit `model:"haiku"` billed
  correctly; `model:"auto"` on `"thanks so much!"` → haiku, on a
  security-audit/root-cause/step-by-step prompt → opus — both billed
  correctly with `requested_model:"auto"` present in the response;
  `stream:true` produced real incremental `delta` events followed by one
  `done` event carrying accurate `usage`/`credits_charged`/
  `credits_remaining`, then `[DONE]`; an invalid key correctly 401s; an
  unrecognized `model` value correctly falls back to sonnet (no
  regression). The rate-limit tier's `.in('metadata->>credit_pack', [...])`
  filter was verified against the real PostgREST endpoint directly
  (`Accept-Profile: public` header needed for a raw curl, same artifact
  this file's `verify_generation_receipt` note from 2026-10-05 already
  documents) rather than by spamming 90 real paid requests to trip the
  cap — confirmed the filter correctly matched a seeded `power`-pack
  purchase row. `developers.html` updated: the request table now
  documents `model:"auto"` and `stream`, a new "Streaming" section shows
  the real event shapes, the 429 row and the "known v1 gaps" card both
  rewritten to reflect what's fixed vs. still genuinely absent (no
  conversation history, no attachments, no tool use on this endpoint).
  Cleaned up: deleted the throwaway account (zero orphaned rows across
  `profiles`/`credit_ledger`/`api_keys`/`auth.users` confirmed),
  `test-admin-setup` re-stubbed to 410 and confirmed via a live curl.
  **(3) Linked `/trust.html`** from `app/signup.html` (the existing
  "no data sold" note is now a real link) and `app/login.html` (a new
  note line: "row-level security on every table · verifiable deletion
  receipts · see how we protect your data").
  **Scope note**: the roadmap's other sections (broader integrations
  beyond GitHub/Notion, landing pages for new verticals, growing the
  newsletter/blog) were left alone — correctly-scoped future work, not
  cheap/clear-cut enough to build without a separate go-ahead, consistent
  with how the homepage-feedback review below was triaged the same way.

- **2026-10-08** — **Acted on three of the cheap/accurate items from an
  external homepage-feedback review** (user pasted a 3rd-party critique,
  asked "Does this help" — graded each claim against the live page before
  acting rather than assuming it was accurate; see that assessment for the
  full breakdown). Three findings were real and cheap to fix, shipped here:
  (1) **Unified the 4 primary (`btn-lg btn-orange`) CTAs** — they'd drifted
  to 4 different wordings ("Start Free — No Card →", "Try it free — 200
  credits →", "Start Free — 200 credits, no card →", "Start for Free →")
  across the hero, post-steps, post-calculator, and final-CTA sections. All
  4 now read identically: "Start free — 200 credits, no card →". Smaller
  secondary CTAs (`btn-sm`/`btn-ghost`, e.g. the nav pill, the two
  Intelligence-section mini-CTAs, the pricing-panel "Get started free →")
  were deliberately left alone — they sit right next to explanatory text
  that already states the credits/no-card details, so their brevity is
  correct, not an inconsistency. (2) **Added a "Risk of forgetting to
  cancel" row to the `#compare` table** — a real, previously-missing angle
  (commitment/lock-in anxiety) distinct from the existing "Monthly
  subscription" and "Pay only when you use it" rows, worded accurately
  (ChatGPT Plus/Claude.ai Pro *can* be canceled anytime too — the honest
  framing is "recurs until you do," not "can't be canceled," since
  overstating a competitor's lock-in would violate this project's own
  no-overclaiming policy). (3) **Added a concrete weekly-usage example**
  under the existing "What a task actually costs" panel in `#pricing`:
  "15 quick questions, 5 longer explanations, and 1 deep review a week ≈
  40 credits — about $3/month on the Value pack ($10/600 credits)" — the
  credit/dollar math is derived arithmetically from the exact per-task
  numbers already published two lines above it (15×1 + 5×2 + 1×18 = 43cr/
  week ≈ 186cr/month at the Value pack's $0.0167/credit rate ≈ $3.11,
  rounded), explicitly framed as "Example:" rather than a claimed
  real-usage statistic — this project has a standing, hard-learned policy
  against fabricating usage/social-proof numbers (see the 2026-09-28
  testimonials-removal entry), so a plausible invented-but-labeled
  illustration was the right call, not a bare "most users spend X" claim
  with no data behind it.
  **Explicitly NOT done, flagged back to the user rather than built
  unilaterally**: a "For business" / "For developers" tab split under the
  hero (a genuinely good, novel idea, but nothing like it exists today —
  real scope, not a quick fix) and reversing the "Not a chatbot. An
  orchestration layer." H1 (that headline was a deliberate, explicit
  brand-identity choice — offered 3 options, user picked this one, on
  2026-10-06 — reversing it needs the same kind of explicit go-ahead, not
  a drive-by edit riding on unrelated feedback). Also explicitly declined:
  a fabricated "N queries processed this week" trust stat the original
  feedback suggested — directly the same mistake this project already
  corrected once; real usage is still near-zero, so there's no honest
  number to show yet.
  **Verified via a locally-served copy** (not production) with Playwright:
  zero console errors on load; confirmed via `page.locator(...).
  allTextContents()` that exactly the 4 intended buttons now read
  identically (the Discord CTA, picked up by the same broad selector
  pattern, correctly stayed untouched); screenshotted the new comparison
  row and the new pricing example line individually — both render cleanly
  with no layout breakage; a full `html.parser` pass over the whole file
  and `node --check` on all 3 inline `<script>` blocks both still clean.
  **Scope**: pure copy/markup changes to `index.html` only — no CSS
  structure change, no JS logic, no backend/migration/edge-function
  involvement.
- **2026-10-07** — **Site-guardian sweep: swept clean, no issues found** (user
  asked to "Run the site-guardian" the same day the 19-function CORS fix
  merged). Full 7-item checklist run: Supabase advisors (only previously
  -accepted finding classes), edge-function drift (28 live vs 24 committed —
  the gap is exactly the known 4-function diagnostic-stub set, no drift),
  24h error-rate check (exactly one stray `401` on `chat` — a gateway JWT
  rejection, not a pattern), schema drift (`pg_trigger` on `auth.users` and
  `pg_cron.job` both match this file's documented baseline exactly), a live
  smoke test with two real throwaway accounts (signup → exactly one
  `profiles`/`referral_codes`/`signup_bonus` row; real chat sends on all
  three `MODEL_MAP` keys succeeded with correct billing and signed
  generation receipts; referral redemption happy/duplicate/self/invalid
  paths all correct; `buy-credits` resolved to a real `checkout.stripe.com`
  URL), static-page liveness, and the hard-security-constraint grep (zero
  `buy.stripe.com` matches). Cleaned up: both throwaway accounts deleted,
  zero orphaned rows confirmed, `test-admin-setup` re-stubbed to 410 and
  confirmed via a live curl. No PRs needed.
- **2026-10-07** — **Visual polish pass, part 5: the app surfaces**
  (`app/chat.html`, `app/dashboard.html` — user asked to "go ahead with the
  app-surface visual pass" after being offered a choice between this and
  waiting on purchase-funnel instrumentation data). `app/login.html` and
  `app/signup.html` were audited too and found already clean (proper SVG
  OAuth icons, only the accepted semantic `✓` checkmark convention) — no
  changes needed on either.
  **`dashboard.html`**: 3 raw-emoji icons (⚠ load-failure message, ✅
  auto-topup-on card, ⚡ every buy-credits pack card) replaced with the
  established outline-icon system (alert-triangle, check-circle, filled
  lightning bolt — all reused shapes, colors matched to each context's
  existing accent).
  **`chat.html`** (the largest single-page icon audit in this workstream —
  ~50 raw-emoji instances across sidebar nav, composer banners, receipt/
  onboarding modals, and all 6 Intelligence-panel tabs): replaced every
  *primary-chrome* icon (sidebar nav, prompt chips, low-balance/trial-limit/
  depleted/post-reply-nudge banners, attach button, receipt modal headers,
  Intelligence panel header, doc-upload button, routine email-notify label,
  Community Gallery title, all empty-state icons across Tasks/Knowledge/
  Routines/Memory/Search, the 3-step onboarding modal, and the tool-call
  card icon map for web_search/GitHub/Notion) with the hand-authored 24×24
  outline-SVG system, reusing shapes already established elsewhere in the
  repo wherever the concept matched (document, globe, magnifying glass,
  brain, envelope, lock, GitHub logo mark) rather than inventing one-offs.
  New small `.ic{width:1em;height:1em}` utility class scales each icon to
  its container's own font-size automatically.
  **Deliberately left alone, two different reasons**: (1) the voice-input
  button's 🎙/🔴 recording-state toggle — a small, self-contained
  functional widget where converting only the SVG-eligible states would
  have created a worse visual inconsistency than leaving it as emoji
  throughout; (2) `✓`/`✗`/`➜`/`✎`/`×` used as plain monochrome status
  glyphs (signature-verify results, "Connected"/"Copied" confirmations,
  "then:" chain arrows, conversation rename, close buttons) — left alone
  as the same accepted dingbat-as-UI-symbol convention already established
  repo-wide (pricing.html's comparison table, trust.html's checklist). Also
  found a related, smaller internal-consistency issue while auditing the
  routine-card action row: 3 of its 7 buttons (Email on/off, Webhook, Fork)
  carried emoji while the other 4 siblings (Publish, the On/Off toggle, Run
  now, Delete) never did — rather than adding icons to all 7 (over-designing
  a small secondary toolbar), dropped the emoji from those 3 to match the
  row's own established plain-text convention; the same drop-not-convert
  call was made for two other small inline badges (the routine list's
  "public" marker, the search-result "chat"/"doc" kind pill) for the same
  reason — both sit beside plain-text sibling labels with no icon at all.
  **Verified via a locally-served copy** (not production) with Playwright:
  `node --check` on every inline `<script>` block (both files) and a full
  `html.parser` pass over `chat.html`'s ~3100 lines, both clean; zero
  `pageerror`/console errors on load; every edited element's live
  `outerHTML` pulled directly from the DOM and confirmed correct (not just
  source-code review) for the Intelligence-panel static markup, modal
  headers, and composer banners; the 3-step onboarding modal screenshotted
  step-by-step (sparkle/lightning/brain icons, all crisp and correctly
  colored); the Knowledge, Routines, Search, and Memory tabs screenshotted
  individually; the sidebar's gift-box icon (for "Share & Earn") read
  ambiguously at default screen-capture scale — zoomed in at 4x device
  scale to confirm it renders correctly, not a rendering bug; the 3
  composer-banner icons and attach-button paperclip screenshotted together
  forced-visible; the 3 prompt-chip icons (daily-briefing/upload-doc/
  create-routine) screenshotted by re-injecting the original static markup
  into a live page (since anonymous/trial mode rebuilds `#emptyState`'s
  `innerHTML` without them — pre-existing, documented behavior, not
  something this pass touched). `dashboard.html`'s 3 icons verified by
  rendering its exact CSS + markup in isolation (no live backend needed for
  a pure CSS/icon check) — all three crisp and correctly colored.
  **Scope note**: pure CSS/markup + a handful of JS string-literal changes
  (icon markup swapped in place of emoji in existing `textContent`/
  `innerHTML` assignments); no business logic, API shape, or DB/edge
  -function change anywhere in this PR.

- **2026-10-06** — **Extended the CORS-wildcard fix to the remaining 19 edge
  functions** (the user explicitly asked to "do the same CORS fix for the
  other 18 functions" after the `chat`/`buy-credits` fix below merged —
  re-grepping found 19, not 18, since one more function had landed with the
  same wildcard between the two passes). Applied the identical
  `corsHeadersFor(req)` allowlist pattern (echo `aethyro.com`/
  `www.aethyro.com`/preview-subdomain origins, fall back to the production
  origin for anything else, `Vary: Origin`) to every function, preserving
  each one's own existing `Access-Control-Allow-Headers`/`-Methods` list
  exactly (several differ: `trial-chat` only allows `apikey, content-type`,
  `webhook-routine-trigger` only `content-type`, the decommissioned stubs
  and `send-newsletter` carry an extra `Access-Control-Allow-Methods`).
  Functions touched: `activate-license`, `api-chat`, `connector-proxy`,
  `create-checkout`, `customer-portal`, `embed-content`, `redeem-referral`,
  `run-agent-task`, `run-routines`, `send-low-credit-email`,
  `send-newsletter`, `send-onboarding-email`, `send-routine-result-email`,
  `send-welcome-email`, `setup-auto-topup`, `team-manage`, `trial-chat`,
  `validate-license`, `webhook-routine-trigger`.
  **Two functions (`send-low-credit-email`, `send-routine-result-email`)
  had no module-level CORS const at all** — only an inline wildcard on the
  OPTIONS preflight, with every other response carrying zero CORS headers
  (internal-only, `X-Internal-Key`-authenticated, never called from a
  browser). Fixed the same way, scoped to just that preflight — no new
  behavior added to responses that never had CORS headers to begin with.
  **`embed-content` needed one structural change beyond the others**: its
  `ok`/`err` closures live inside a separate `handleRequest()` function
  called from the main handler, not inline — threaded the per-request
  `CORS` object through as an explicit parameter rather than relying on a
  module-level const.
  **`api-chat` is the one function in this batch with a legitimate external
  (non-aethyro.com) usage pattern** — it's the public, API-key-authenticated
  endpoint meant for a user's own scripts/backends (see `developers.html`).
  Locking its CORS down doesn't restrict that usage at all: CORS is a
  browser-only enforcement mechanism, so a server-side script or backend
  calling with an API key was never gated by this header either way — only
  a browser-based cross-origin caller is affected, which isn't this
  endpoint's documented usage pattern. Noted this explicitly in the
  function's own comment so a future session doesn't assume the lockdown
  needs reverting.
  **Verified**: all 19 deployed with their pre-existing `verify_jwt`
  settings passed explicitly (10 were `true`, 9 `false` — confirmed via
  `list_edge_functions` before any deploy); all 19 fetched back via
  `get_edge_function` and diffed byte-for-byte clean against local disk;
  curl OPTIONS allow/deny checks against 8 functions spanning every
  structural variant present (`api-chat`, `trial-chat`,
  `webhook-routine-trigger`, `send-low-credit-email`, `create-checkout`,
  `send-newsletter`, `embed-content`, `run-routines`) all showed the
  correct echoed-vs-fallback behavior, never a wildcard — the remaining 11
  weren't individually curl-tested since their `corsHeadersFor` logic is
  mechanically identical to the tested set and already diff-verified
  against disk. No business logic changed in any of the 19 — only CORS
  header computation — so no throwaway-account functional smoke test was
  run, matching the same reasoning as the `chat`/`buy-credits` PR.
  **Scope note**: this closes the CORS-wildcard pattern across every edge
  function in the repo — nothing left with a bare `"*"` as of this PR.
- **2026-10-06** — **Closed the CORS-wildcard gap on `chat` and `buy-credits`**
  (one of the 5 remaining items from the 2026-10-03 audit re-run — "CORS
  wildcard on `chat`/`buy-credits`" — selected explicitly by the user out of
  that list, not a broader sweep). Both functions had a bare
  `"Access-Control-Allow-Origin": "*"`, letting any website make
  authenticated cross-origin calls against these two billed endpoints.
  Replaced with a per-request origin check: `corsHeadersFor(req)` echoes
  back the request's `Origin` only if it's `https://aethyro.com`,
  `https://www.aethyro.com`, or matches this project's Cloudflare preview-
  subdomain pattern (`<branch-or-commit>-aethyro-landing.<account>.workers.dev`,
  so branch/commit previews can still exercise live chat/checkout);
  any other origin gets the production origin back instead (never echoed,
  never a wildcard), which the browser's own CORS enforcement then rejects
  for that caller. Added `Vary: Origin` on both. `chat` now at v48,
  `buy-credits` at v15 — both deployed with their pre-existing `verify_jwt`
  settings passed explicitly (`true` for `chat`, `false` for `buy-credits`,
  confirmed via `list_edge_functions` before deploying) per this file's own
  deploy-gotcha above.
  **Severity framing, stated directly in both functions' own version-history
  comments**: this is defense-in-depth, not a fix for an active exploit —
  both endpoints are Bearer-token-authenticated (not cookie-based), so a
  malicious cross-origin page can't automatically attach a victim's
  Authorization header the way it could a cookie; it would need the token
  via some other means (e.g. XSS) regardless of this CORS header. Still
  worth closing since a wildcard origin on a billed endpoint is exactly the
  kind of finding that shows up in any outside security review.
  **Verified live**: fetched both functions' deployed source back via
  `get_edge_function` and diffed byte-for-byte against local disk (clean on
  both) before trusting either deploy. Then a real curl-based OPTIONS check
  against both functions with three Origin cases each — `https://aethyro.com`
  (echoed back correctly), `https://evil.com` (correctly falls back to the
  production origin, not echoed), and a real preview-subdomain shape
  (`https://abc123-aethyro-landing.leer4030.workers.dev`, correctly echoed) —
  plus a no-`Origin`-header case on `chat` (correctly falls back, doesn't
  error). All matched the intended allowlist behavior exactly.
  **Scope note**: 18 other edge functions share the same `"*"` wildcard
  pattern (grepped repo-wide for completeness) but were deliberately left
  untouched — the user selected specifically "CORS wildcard fix," and this
  project's own audit only ever named `chat`/`buy-credits` as the tracked
  gap (the two functions that actually move money or do billed work from a
  browser context). The other 18 are a separate, not-yet-scoped cleanup if
  wanted later. No business logic changed in either function — only the
  CORS header computation — so no throwaway-account chat/purchase smoke
  test was run for this PR; the curl-based header verification above is the
  right-sized check for a change this narrow.
- **2026-10-06** — **Homepage hero headline rewrite — the brand-identity
  decision held back from the resurfacing pass directly above.** Offered
  the user 3 headline options that repositioned the hero around
  orchestration instead of the model (A: directly promote the existing
  "Not a chatbot. An orchestration layer." line into the H1; B: lead with
  outcome ("One request. Five systems working."); C: minimal change,
  keep "Your AI assistant" and only swap the second line). User picked
  **A**. Replaced the H1 (`Your AI assistant. / Powered by / Claude Opus
  5.` → `Not a chatbot. / An orchestration layer.`) and the hero
  sub-paragraph (now leads with "Powered by Claude Opus 5, but built to
  do more than answer" — the model demoted from subject to supporting
  detail, not removed entirely, since dropping it altogether was its own
  identified risk in the original feedback).
  **Found and fixed a direct consequence of the rewrite, not a separate
  bug**: the agent-visualizer section immediately below the hero had used
  that exact same phrase — "Not a chatbot. An orchestration layer." — as
  its own `<h2>` (added before this project adopted the icon/gradient
  workstream's current section-naming conventions). With the identical
  phrase now also the H1, a visitor would have read the same four words
  twice in a row scrolling past one ticker strip. Reworded that section's
  eyebrow + h2 to build on the hero instead of repeating it verbatim:
  "The actual differentiator" → "How it actually works",
  "Not a chatbot. An orchestration layer." → "Five specialized systems.
  One message in." — left its body paragraph and the 4 subsystem cards
  (Tasks/Knowledge/Routines/Integrations) untouched, since those were
  never duplicative. Also removed the `#orchestration`-linked kicker line
  added in the resurfacing pass (directly above the old H1) — it existed
  specifically to preview the "not a chatbot" line before a reader
  reached it; now the H1 *is* that line, so the kicker above it would
  have been pure duplication. The `id="orchestration"` anchor itself was
  left in place (harmless, and still a reasonable in-page target even
  with nothing currently linking to it).
  **Deliberately out of scope, left as-is**: `<title>`/OG/Twitter meta
  tags still read "AI Assistant Powered by Claude Opus 5" — these are a
  different risk class (search ranking / share-card signals, not
  something a visitor reads on the page itself) and weren't part of what
  the user approved; changing them wasn't requested. Every other
  "Powered by Claude Opus 5" mention elsewhere on the page (the trust-
  signal row, the role-picker sub-copy, the FAQ) are supporting-detail
  mentions, not headline-level claims, so they're consistent with the
  new "model as engine, not identity" framing without needing a rewrite.
  **Verified via a local-served copy** with Playwright: zero horizontal
  overflow at 1440×1700 and 390×1700, a dedicated element-level
  screenshot of the `#orchestration` section confirmed the new heading no
  longer duplicates the hero, and all real inline `<script>` blocks parse
  clean (re-confirmed the page's 3 JSON-LD blocks are expected non-JS
  "failures" under a syntax check, same as the resurfacing pass above —
  this page has structured-data blocks most others touched by the
  workstream don't).

- **2026-10-06** — **Homepage messaging resurfacing pass**, from external
  review-style feedback on 5 points (model dependence, differentiation
  position, credit ambiguity, social proof, comparison friction). Checked
  each claim against the actual page before acting, rather than assuming
  the feedback was accurate as given: 3 of the 5 were already substantially
  built — a full "How we compare" table (Aethyro vs. ChatGPT Plus vs.
  Claude.ai Pro) already existed, the "Not a chatbot. An orchestration
  layer." section is literally the very next section after the hero (not
  "mid-page" as claimed), and the fabricated-testimonials-vs-honest-
  early-stage-copy tradeoff was already a deliberate, previously-made
  product decision (see the 2026-09-28 testimonials-removal entry) — a
  public routines gallery (`/routines.html`) already exists too. The real
  gap in those three was **visibility**, not missing content: everything
  was built but positioned below the fold with no hook in the hero
  pointing to it. Fixed that specifically, as pure additions with zero
  rewriting of existing sections: (1) added `id="orchestration"` to the
  agent-visualizer section and a new linked eyebrow-style kicker
  ("Not a chatbot — an orchestration layer ↓") directly above the H1 —
  same literal phrase as the section it jumps to, a deliberate callback
  rather than a model-identity rewrite, since demoting "Powered by Claude
  Opus 5" from the headline itself is a real brand-identity call being
  held for a separate, explicit decision (see directly below); (2) added
  `id="compare"` to the comparison-table section and a new hero caption
  line ("vs. Claude.ai Pro & ChatGPT Plus — see the comparison →")
  directly under the existing credit-signup caption.
  **Credit ambiguity was a genuine, unaddressed gap** — the hero's "200
  free credits" badge had no unit explanation anywhere near it. Fixed
  with real, already-published numbers pulled from `pricing.html`'s own
  FAQ (not invented): "(~13 Opus replies, or ~200 quick ones)" — the
  exact same figures that page already uses to describe the free grant,
  so this doesn't introduce a second, possibly-drifting claim about what
  200 credits buys.
  **Verified via a local-served copy** with Playwright at 1440×1600
  (desktop) and 390×1600 (mobile): both new anchor ids resolve
  (`getElementById` check, not just visual), zero horizontal overflow at
  either width, the new kicker/caption lines wrap cleanly on mobile
  without crowding the existing CTAs, and all inline `<script>` blocks
  still parse clean (confirmed the 3 JSON-LD `<script type="application/
  ld+json">` blocks are expected non-JS parse "failures" under a
  JS-syntax check, not a regression — this page has structured-data
  blocks the other pages touched by this workstream don't).
  **Deliberately not done this pass, held for a separate decision**:
  rewriting the H1 itself to lead with "orchestration layer" instead of
  "Powered by Claude Opus 5" — offered the user 2-3 headline options
  that reposition identity around orchestration rather than the model,
  for an explicit pick before any of that copy ships, since unlike the
  resurfacing fixes above this is a real brand-identity decision, not an
  additive/reversible one.

- **2026-10-06** — **Visual polish pass, part 4: the 3 orphaned-then-relinked
  SEO landing pages** (`atlas-web-design`, continuing PRs #132/#133/#134 —
  user asked to "do the SEO pages next (use-cases, claude-opus-alternative,
  ai-chat-for-developers)"). These three predate the icon-system work
  entirely (added 2026-09-26, before any session documented in this file)
  and run on a distinct, older CSS architecture from every other page
  touched by this workstream so far — `--bg:#0a0a0a`/`--t2`/`--t3` tokens
  instead of the `--s1`/`--s2`/`--b1`/`--b2` system, and, notably, **the
  only 3 pages on the entire site with real `prefers-color-scheme:light`
  support** (a `@media` block redefining the palette for light-mode
  visitors) — every other page on aethyro.com is dark-only. That meant
  every change this pass made had to be verified in both color schemes,
  not just dark, since this is genuinely different surface area from
  the previous three passes.
  **Icon audit**: `use-cases.html` had 12 raw-emoji icons across 3
  four-card use-case grids (🔍🐛🏗️📝 developers / 📄🔬📊⚖️ researchers /
  ✍️📧🎯🌍 writers) and `ai-chat-for-developers.html` had 6 more
  (🔍🐛🏗️📝🔄📚, 4 of which are the same concepts as `use-cases.html`'s
  developer section) — both genuinely needed the icon-replacement
  treatment this time, unlike `developers.html`/`routines.html` in part 3,
  since these are marketing feature-grid pages (the same category as
  `index.html`'s bento cards and `pricing.html`'s feature grid, both
  already fixed), not docs or user-generated content.
  `claude-opus-alternative.html` had just one (⚡ in the hero badge).
  **Treatment**: designed 9 new outline icons in the established 24×24,
  `stroke-width:1.7`, round-cap/join system (magnifying glass, bug,
  pencil/edit, flask, bar chart, legal scale, target, globe, book) and
  reused 3 already-built shapes exactly where the concept matched
  (building, from `trust.html`'s Infrastructure icon, for both pages'
  "Architecture"/"Architecture review" cards; envelope, from
  `trust.html`'s "Found a problem?" icon, for "Professional
  communication"; the filled lightning bolt, from `index.html`'s bento
  cards, for the hero badge) — rather than inventing visually
  inconsistent one-offs. `use-cases.html`'s three 4-card sections each
  get one accent color (cyan/developers, violet/researchers,
  orange/writers) instead of 12 individually-chosen colors — a
  section-level palette, same restraint logic as `trust.html`'s
  per-section (not per-icon) coloring. `ai-chat-for-developers.html`,
  being entirely developer-focused, reuses its own existing cyan badge
  accent for all 6 icons rather than introducing a second color scheme.
  Added `--cyan`/`--violet` to `use-cases.html`'s `:root` (it had neither;
  the other two pages already had `--cyan` from their existing badges).
  **Gradient headlines**: added `.grad-orange` + a headline `<span>` to
  all three H1s (`use-cases.html`: "with Aethyro"; `claude-opus-
  alternative.html`: "Claude Opus 5"; `ai-chat-for-developers.html`:
  "AI pair programmer") — the same cross-page consistency fix applied to
  `developers.html`/`routines.html`/`trust.html` in part 3. Left the
  `compare-table`'s `✓` marks in `claude-opus-alternative.html` alone —
  same accepted semantic-checkmark convention as `pricing.html`'s table.
  **Verified via a local-served copy** (not production) with Playwright
  across all three pages at three configurations each — 1280×900 dark,
  390×844 dark, **and 1280×900 light** (the light-mode check specific to
  this pass, since no prior pass in this workstream needed one): zero
  horizontal overflow in all 9 combinations, all 21 new/reused icons
  render crisp and legible in both color schemes (the accent colors
  chosen — cyan/violet/orange — all hold reasonable contrast against
  both the near-black dark cards and the near-white light cards, checked
  visually in the actual rendered screenshots rather than assumed), all
  3 inline `<script>` blocks still parse clean, and a re-grep for emoji
  across all three files afterward found zero remaining (only the
  intentional `✓` table marks noted above). One icon (the book, for
  "Library research") read ambiguously at full-page thumbnail scale in
  the first screenshot pass — zoomed into just that icon region to
  confirm it renders correctly as a book, not a rendering bug, before
  trusting the full-page QA pass as sufficient.
  **Scope note**: pure CSS/markup, no JS logic, no backend/migration/
  edge-function changes — matching every prior pass in this series.

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
