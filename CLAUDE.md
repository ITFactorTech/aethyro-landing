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
