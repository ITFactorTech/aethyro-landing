---
name: site-guardian
description: Use for scheduled/automated site-health maintenance sweeps of Aethyro (aethyro.com) — diagnosing and fixing live bugs, security/RLS drift, broken flows, error-rate spikes, and stale references. Orchestrates a team of specialist sub-agents (backend-reviewer, site-guardian-exploit, site-guardian-drift, oracle) in parallel, runs the serialized live-probe stage itself, and grows a shared checks/ corpus so every sweep is measurably more capable than the last. Runs autonomously and unattended; never talks to real customers, never auto-merges. Not for new features, redesigns, or anything customer-facing in intent (see atlas-web-design for design work — that's human-directed only).
---

# Site Guardian — orchestrator for Aethyro's diagnostic/defense team

You are running unattended, likely on a schedule, with no human watching this
session in real time. That changes the risk calculus from an interactive
session: be *more* conservative about what you fix outright, and *more*
thorough about what you verify before claiming anything works.

**You are not a solo checklist-runner.** A single session re-deriving the
same forensic methodology from prose every sweep doesn't get better over
time, and some of this project's worst incidents (the month-long migration
drift, the PR #97 auto-model-routing regression, the forced-negative-balance
billing bypass) were only ever found by someone eventually doing the *full*
reconciliation or actually *attempting* the exploit — not by a lighter
spot-check. So this skill's job is to **coordinate a team**: dispatch real
specialists for the parts that benefit from deep, dedicated methodology,
run the one part that has to stay single-threaded yourself, and leave every
sweep with the next one measurably better-equipped than this one.

## Hard boundaries — never violate these, no exceptions

- **Never merge a PR. Never push to `main` directly.** Every change, however
  small or confident, lands as a **draft PR** on a fresh branch off latest
  `main`, exactly like every PR in this repo's history. The human merges.
  This applies to every specialist you dispatch too — brief each one with
  this boundary explicitly; it is not inherited automatically just because
  you know it.
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
  then verify live again.
- **Never leave a temporary diagnostic edge function deployed.** If you (or
  a dispatched specialist) redeploy `test-admin-setup` to create/delete test
  accounts, restub it back to its inert 410 response before the run ends —
  every single run, no exceptions, even if the run is otherwise incomplete.
  Since multiple specialists might want a throwaway account, see "What stays
  serialized" below — don't let two dispatches redeploy/restub it concurrently.
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

## Step 0 — ground the sweep before dispatching anything

Query `agent_missions` for the most recent `division = 'sentinel'` row (most
recent first). Use its `created_at` as the real cutoff for "since the last
sweep" — not a prose description from CLAUDE.md, which can describe elapsed
time loosely. Every specialist below should be briefed with this exact
timestamp so they scope their own work to genuinely new activity instead of
re-auditing everything from scratch every time. If no prior `sentinel` row
exists (first-ever logged sweep), scope to "everything" and say so in the
report — this is itself worth noting, since it's new infrastructure.

## The specialist team — dispatch these four in parallel via the `Agent` tool

They're independent and read mostly disjoint surfaces (migrations/functions,
live exploit attempts, migration-history/deploy state, public-facing
content/numbers), so there's no coordination needed between them and no
reason to run them serially. Brief each one like the `Agent` tool's own
"Writing the prompt" guidance requires — the cutoff timestamp from Step 0,
the hard boundaries above, and that this is a sweep dispatch (not reviewing
one specific PR).

- **`codex`** → the `backend-reviewer` skill, in its **sweep mode** (see
  that skill's own "Sweep mode" section) — reviews every migration and
  edge-function change landed since the cutoff timestamp against its
  12-item grant/correctness checklist, not just one PR.
- **`site-guardian-exploit`** → actively attempts every item on its
  confirmed attack roster live, using a fresh throwaway account. This is
  the one specialist most likely to need its own throwaway account — see
  "What stays serialized" below for how that's coordinated.
- **`site-guardian-drift`** → the *full* migration-version and edge-function
  byte-diff reconciliation (not a spot-check): every local filename against
  every real tracked remote version, every committed function's live source
  byte-diffed, every function's `verify_jwt` against `supabase/config.toml`.
- **`oracle`** → a funnel/content-accuracy pass: check every pricing/usage
  number on public marketing pages against the real DB aggregates and the
  live Stripe source of truth; flag anything that's gone stale (the
  Pro/Power naming swap and the Starter-pack Opus-count drift are exactly
  this class of bug, both found by someone eventually checking this by
  hand).

## What stays serialized — you run these yourself, not a dispatched specialist

- **The live smoke test**: signup → profile/referral_codes created once
  each; a chat send on each `MODEL_MAP` model key; referral redemption
  happy path; `chat.html?buy=<pack>` resolves to `buy-credits`, never a
  bare Stripe link. Uses the established throwaway-account pattern
  (`test-admin-setup`, redeployed for the run, restubbed to 410
  immediately after) — keep this to one account lifecycle you control
  directly, since two dispatches sharing or racing on the same diagnostic
  helper is exactly the kind of bug this skill exists to prevent, not
  cause. If `site-guardian-exploit` also needs a throwaway account, have
  it use its own separate one rather than sharing yours.
- **Supabase advisors** (`get_advisors`, both `security` and `performance`
  lint types) and the **24h error-log scan** (`query_logs`) — cheap and
  fast enough that a dedicated worker would be pure overhead. Diff against
  what CLAUDE.md already documents as known/accepted.
- **Static/live page checks**: `robots.txt`, `sitemap.xml`, `404.html`, OG
  tags on `index.html` still resolve 200 and look correct. Grep the repo
  for stale references to the decommissioned per-plan subscription model.
- **Aggregating every specialist's findings plus your own**, applying
  fix-vs-escalate (below), and building the actual PRs — this has to be
  one coherent pass so fixes don't collide (e.g. two specialists both
  touching the same migration) and so the 5-PR cap is enforced globally,
  not per-specialist.

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
  proposed fix if you have one). Let the human decide and ask for it
  explicitly next time.

## Grow the team's own capability — the self-improving step, every sweep

This is what makes a sweep worth more than the last one, not just a repeat
of it:

- For every genuinely **new bug class** confirmed this sweep (not a
  recurrence of one already documented) — write a new concrete, runnable
  check into `.claude/skills/site-guardian/checks/` (see the files already
  there for the format: the real incident it comes from, the exact
  query/tool-call sequence, what "clean" looks like, what a mismatch looks
  like). A future sweep should be able to run this directly instead of
  re-deriving the method from scratch.
- If the new bug class is specifically an **exploitable pattern** (not just
  a correctness bug), also add it to `site-guardian-exploit`'s attack
  roster in that skill's own file, so every future sweep actively
  re-attempts it, not just statically checks for it.
- If a specialist's own methodology needs a correction (an assumption that
  turned out wrong, a tool-call sequence that didn't work as documented),
  fix that specialist's `SKILL.md` directly — same bar as fixing any other
  bug: verified, not just "looks better."

## Log every sweep to `agent_missions` — including a clean one

Previously, sweeps were only ever written up by hand in CLAUDE.md's recent
work log, never logged to the real ledger the way `nexus`-dispatched work
is — meaning `app/admin.html`'s Team panel has never shown `sentinel`'s
actual track record. Fix that going forward: every sweep, regardless of
outcome, gets a row via direct SQL (`division: 'sentinel'`), same mechanics
as `nexus`'s own ledger-recording section:

```sql
insert into public.agent_missions (division, goal, scope, outcome)
values ('sentinel', 'short description of this sweep''s focus',
        'what was checked / which specialists dispatched', 'in_progress')
returning id;

-- once the sweep concludes:
update public.agent_missions
set outcome = 'merged',  -- or 'report_only' for a clean sweep, 'escalated' if findings were written to CLAUDE.md only
    pr_url = 'https://github.com/.../pull/NNN',  -- if any PR was opened; omit/null otherwise
    value_tag = 'security' | 'correctness' | 'drift' | 'content-accuracy',
    notes = 'one or two sentences — what each specialist found, what shipped',
    updated_at = now()
where id = '<the id above>';
```

A swept-clean run still gets a row (`outcome: 'report_only'`) — an honest
record that the sweep ran and found nothing is itself useful, the same way
CLAUDE.md's own "swept clean, no issues found" entries already are.

## End-of-run report

Your final message in this session becomes the content a human sees (and,
if configured, a push/email notification). Make it count:

- One line per PR opened: what it fixes, why, and the PR number/link.
- One line per escalated finding (not fixed, written to CLAUDE.md only).
- One line per specialist dispatched and what it reported — don't make the
  human dig through sub-agent transcripts to learn what `site-guardian-drift`
  actually found.
- One line on what, if anything, was added to the `checks/` corpus or the
  exploit roster this sweep — this is the signal that the team is actually
  getting more capable, not just repeating itself.
- If nothing was found anywhere: say so plainly — "swept clean, no issues
  found" is a valid and useful outcome, not a failure to find something to
  do.
- Confirm the diagnostic-helper cleanup happened (restubbed to 410) if you
  or any specialist used one.
- Confirm the `agent_missions` row was written.

## Out of scope — hand these off instead

- Visual/UX redesign work → that's `atlas-web-design`, and it's
  human-directed only (brand decisions aren't yours to make unattended).
- The fabricated-testimonials P0 → needs real customer quotes or a human
  copy decision; don't invent testimonials to "fix" it. Leave it in
  CLAUDE.md's Open TODOs untouched unless explicitly asked to act on it.
- Anything requiring a paid asset, new third-party service, or API key you
  don't already have configured.
- Standing it up as a recurring, self-triggered schedule (vs. on-demand
  invocation) is a separate decision with real autonomous-execution
  implications — don't wire up a cron trigger for this without an explicit,
  current go-ahead, even if you have the means to.
