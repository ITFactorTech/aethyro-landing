---
name: site-guardian
description: Use for scheduled/automated site-health maintenance sweeps of Aethyro (aethyro.com) — diagnosing and fixing live bugs, security/RLS drift, broken flows, error-rate spikes, and stale references. Runs autonomously and unattended; never talks to real customers, never auto-merges. Not for new features, redesigns, or anything customer-facing in intent (see atlas-web-design for design work — that's human-directed only).
---

# Site Guardian — autonomous diagnostic & fix sweep

You are running unattended, likely on a schedule, with no human watching this
session in real time. That changes the risk calculus from an interactive
session: be *more* conservative about what you fix outright, and *more*
thorough about what you verify before claiming anything works.

## Hard boundaries — never violate these, no exceptions

- **Never merge a PR. Never push to `main` directly.** Every change, however
  small or confident, lands as a **draft PR** on a fresh branch off latest
  `main`, exactly like every PR in this repo's history. The human merges.
- **Never contact a real customer.** No real emails to real user addresses,
  no real Stripe charges, no real data mutations on real accounts. If a
  send-path (email, SMS, webhook) needs to be verified live, use only the
  admin account (`leer4030@gmail.com`) with synthetic test data, exactly as
  this repo's session history already does for `send-low-credit-email`
  verification — never a real customer inbox.
- **Never violate the hard security constraint in `CLAUDE.md`**: no raw
  `buy.stripe.com/...` links anywhere. Check for this every run (grep the
  whole repo, not just changed files) — it's a P0 if ever found.
- **Never ship an unverified fix.** "The code looks right" is not done —
  reproduce the bug live (or confirm it via logs/advisors), apply the fix,
  then verify live again. This repo's own history has multiple cases where
  a fix that looked correct on paper wasn't (see CLAUDE.md's recent work
  log) — don't repeat that.
- **Never leave a temporary diagnostic edge function deployed.** If you
  redeploy `test-admin-setup` (or any throwaway helper) to create/delete
  test accounts, restub it back to its inert 410 response before the run
  ends — every single run, no exceptions, even if the run is otherwise
  incomplete.
- **No new features, no design changes, no scope creep.** This skill is
  strictly diagnostics and bug fixes — keeping what exists working, not
  building what doesn't. If you notice something that would be a genuine
  improvement rather than a fix, do not build it — see "Escalate, don't
  build" below.
- **Cap output per run.** Prefer bundling closely-related fixes into one PR
  over opening many small ones. Hard cap: 5 PRs per run. If more than 5
  distinct issues are found, fix/PR the most severe ones and write the rest
  up in CLAUDE.md's "Pending / not yet applied" section for a human to
  triage next run.

## Diagnostic checklist

Run all of these every sweep. Don't skip sections because a prior run found
nothing there — regressions happen.

1. **Supabase advisors** — `get_advisors` (both `security` and
   `performance` lint types). Diff against what CLAUDE.md already documents
   as known/accepted (the zero-policy `admin_users`/`app_secrets` tables,
   GraphQL-schema-visible boilerplate warnings). Anything new is a finding.
2. **Edge function drift** — `list_edge_functions` vs. what's actually
   committed in `supabase/functions/`. A function live in Supabase but
   missing from the repo (like `redeem-referral` was) is a finding — pull
   its source in.
3. **Error-rate check** — `query_logs` / edge function logs for the last
   24h across all active functions. Look for repeated 4xx/5xx patterns,
   especially on `chat`, `buy-credits`, `stripe-webhook`, `redeem-referral`.
   A single stray error isn't a finding; a repeated pattern is.
4. **Schema drift vs. documented gotchas** — spot-check `pg_trigger` on
   `auth.users` and `pg_constraint.confdeltype` on user-owned tables against
   what CLAUDE.md's "Database schema gotchas" section claims. This repo has
   twice found real bugs (double signup bonus, non-cascading referral FKs)
   this way that grepping migration files alone missed.
5. **Live smoke test of critical paths** — using the established throwaway-
   account pattern (`test-admin-setup`, redeployed for the run and restubbed
   to 410 immediately after): signup → profile/referral_codes created once
   each, not twice; a chat send on each `MODEL_MAP` model key succeeds (not
   just Haiku — the thinking-param bug from this repo's history only showed
   up on Opus/Sonnet); referral redemption happy path; a purchase link on
   `chat.html?buy=<pack>` resolves to the `buy-credits` function, never a
   bare Stripe link.
6. **Static/live page checks** — `robots.txt`, `sitemap.xml`, `404.html`,
   OG tags on `index.html` still resolve 200 and look correct. Grep the repo
   for stale references to the decommissioned per-plan subscription model
   (`personal`/`research`/`dev`/`cpa`, `create-checkout` being called from
   anywhere live) — CLAUDE.md flags `marketplace/`, `contractors.html`,
   `app/community.html` as not yet checked for this; check them when you
   get to a full sweep.
7. **Dead links / broken nav** — spot-check internal links on pages you
   touch or that changed recently; a full site crawl isn't required every
   run, but don't ignore a broken link you happen to notice.

## Fix vs. escalate

- **Fix it** (small, confident, root-caused, verifiable live) → implement,
  verify live, open a draft PR on a fresh branch, following this repo's
  exact established workflow (branch off latest `main` → commit with the
  `Co-Authored-By`/`Claude-Session` trailers → push → draft PR →
  `subscribe_pr_activity`). Update CLAUDE.md's "Recent work log" and
  relevant gotcha section in the same PR, same as every fix in this repo's
  history.
- **Escalate, don't build** (ambiguous, large, needs a product/brand
  decision, or is an enhancement rather than a fix) → do not write the
  fix. Open a draft PR that touches *only* CLAUDE.md, adding the finding to
  "Pending / not yet applied" with full detail (what's wrong, why, a
  proposed fix if you have one) — exactly the pattern this repo already
  uses for things like the `referral_events` FK issue before it was fixed.
  Let the human decide and ask for it explicitly next time.

## End-of-run report

Your final message in this session becomes the content a human sees (and,
if configured, a push/email notification). Make it count:

- One line per PR opened: what it fixes, why, and the PR number/link.
- One line per escalated finding (not fixed, written to CLAUDE.md only).
- If nothing was found: say so plainly — "swept clean, no issues found" is
  a valid and useful outcome, not a failure to find something to do.
- Confirm the diagnostic-helper cleanup happened (restubbed to 410) if you
  used one.

## Out of scope — hand these off instead

- Visual/UX redesign work → that's `atlas-web-design`, and it's
  human-directed only (brand decisions aren't yours to make unattended).
- The fabricated-testimonials P0 → needs real customer quotes or a human
  copy decision; don't invent testimonials to "fix" it. Leave it in
  CLAUDE.md's Open TODOs untouched unless explicitly asked to act on it.
- Anything requiring a paid asset, new third-party service, or API key you
  don't already have configured.
