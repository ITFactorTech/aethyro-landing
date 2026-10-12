# Check: migration-history reconciliation, exact 1:1

**First found by**: a drift between `supabase/migrations/` and the real
`supabase_migrations.schema_migrations` table that went unreconciled for
over a month, discovered only 2026-10-09 by finally doing the complete
diff rather than a sample. That reconciliation uncovered 38 misnamed local
files, 26 missing-from-local remote versions (3 of them pre-dating this
repo's own migration history entirely), and — critically — **two real,
currently-broken live features** hiding inside the mismatch
(`newsletter_reactions` and `conversations.share_token`, both committed to
the repo but never actually applied live).

**Why a sample isn't enough**: `apply_migration` stamps `schema_migrations
.version` with the call's own real timestamp, completely independent of
whatever filename a migration is later committed under. This means a
"recent migrations look fine" spot-check gives false confidence — the
drift accumulates silently in the middle of the history, not just at the
edges, and only shows up on a full diff.

## Steps

1. Call `list_migrations` — this is the real, live, tracked version list.
   Record every version number.
2. List every filename in `supabase/migrations/` and extract its version
   prefix (the leading timestamp). Record every one.
3. Diff the two sets fully, both directions:
   - A live version with no matching local prefix → **missing from repo**.
     Pull its real SQL via a direct query against
     `supabase_migrations.schema_migrations.statements` for that version
     and commit it as a new local file.
   - A local prefix with no matching live version → **don't assume this is
     wrong**. Before treating it as drift, pull the live SQL for the
     *nearest* unmatched live version and diff its actual content against
     this local file. Three possible real outcomes, not just one:
     - Content is identical or a harmless rename → `git mv` the local file
       to the real tracked version number, keep its descriptive suffix.
     - Content doesn't correspond to any single remote version because
       it's a combined/condensed rewrite of 2+ real remote steps, or a
       corrected final state that supersedes a less-complete remote-tracked
       first draft → mark the local-only version "applied" via a direct
       `INSERT INTO supabase_migrations.schema_migrations` (never re-run
       its SQL for real if doing so would undo a later live fix — check
       the live function/grant state matches the local file's version
       before trusting this path, same discipline as the 2026-10-09
       reconciliation's `get_credit_balance` case).
     - Content genuinely doesn't correspond to anything live at all → it
       was never applied. Check live schema state directly (does the
       table/column/function exist?) — if not, this is a real, currently
       -broken feature. Apply it for real via `apply_migration`, then
       rename the file to match the version it's just assigned.
4. Final verification: re-pull `list_migrations` and re-list local
   filenames. Confirm an exact count match and zero duplicate version
   prefixes locally.

## Clean result

Exact 1:1 — same count on both sides, zero gaps in either direction,
confirmed by a from-scratch re-comparison after any fix, not just trusting
the fix was applied correctly.

## Mismatch

Any of the three outcomes in step 3 that isn't "identical/rename." The
third outcome (a local file that was never actually applied) is the
highest-severity one — it means a feature this repo believes is live isn't,
and nothing before a full reconciliation would ever reveal that.
