# Check: edge-function source byte-diff + `verify_jwt` reconciliation

**First found by**: the PR #97 auto-model-routing regression, 2026-09-28.
A merge-conflict resolution correctly edited `chat/index.ts` in `main`'s
git history to add `routeAutoModel()`, but nothing ever called
`deploy_edge_function` afterward — Cloudflare Workers auto-deploys this
repo's frontend on every `git push`, but **nothing auto-deploys a Supabase
edge function**, ever. The live `chat` function silently kept its pre-#97
behavior (every `model:"auto"` request falling back to Haiku) for days,
invisible to anyone reading `main`'s source, since the source genuinely
was correct — just not live. Separately, `deploy_edge_function`'s
`verify_jwt` parameter defaults to `true` when omitted on redeploy, which
has silently flipped an already-`verify_jwt:false` function's gateway
setting more than once in this project's history (e.g.
`send-low-credit-email`).

**Why git history isn't evidence**: a commit touching a function's `.ts`
file only proves the *repo* changed. The only thing that proves the *live*
function matches is fetching its deployed source back and diffing it.

## Steps

1. `list_edge_functions` vs. `ls supabase/functions/` — bare presence
   check both directions. A live function with zero matching local
   directory, or a committed function directory with nothing live, is a
   finding on its own (this is how `redeem-referral`, `send-newsletter`,
   `send-onboarding-email`, `trial-chat`, and `send-low-credit-email` were
   all originally found drifted into this repo).
2. For every function with *any* commit touching its file since the
   sweep's cutoff timestamp — `git log --since=<cutoff> --name-only --
   supabase/functions/` lists exactly which ones — call `get_edge_function`
   and diff the returned source byte-for-byte against the local file.
   **Do this for every function the git log names, even ones whose change
   was "just" a merge-conflict resolution, not a dedicated feature PR with
   its own deploy step** — that distinction is exactly what caused PR #97's
   regression, since a conflict-resolution commit looks identical to a
   real deploy in `git log` alone.
3. For every function (not just the ones recently touched), cross-check its
   live `verify_jwt` value (`get_edge_function`/`list_edge_functions`)
   against the value recorded in `supabase/config.toml`.

## Clean result

- Zero presence mismatches in either direction.
- Every byte-diffed function matches local disk exactly.
- Every function's live `verify_jwt` matches `supabase/config.toml`.

## Mismatch

- **Presence gap** → pull drifted-in live source into the repo (if live
  has it and repo doesn't), or investigate why a committed function was
  never deployed (if repo has it and live doesn't — check whether this is
  a genuinely unreleased feature or a deploy step that was simply never
  run).
- **Byte-diff mismatch** → redeploy from the current committed source
  immediately (this is live-production-behind-repo drift — treat it with
  the same urgency as a live bug, since it usually *is* one, exactly as it
  was for `chat`'s auto-routing). Pass `verify_jwt` explicitly on the
  redeploy, matching whatever `get_edge_function` showed before you
  touched it.
- **`verify_jwt` mismatch** → either `config.toml` is stale (fix it to
  match the live, presumably-intentional value — or redeploy with the
  correct value if the live setting is actually the wrong one) and will
  otherwise silently flip back on the next CI run, or the live setting was
  changed outside this repo's normal path and `config.toml` is the source
  of truth that was never applied — check which is actually true before
  picking a direction.
