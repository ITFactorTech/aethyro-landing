# Shared: agent_missions logging & CLAUDE.md entry format

Every division in this repo's agent team ends its run the same way: one
row in `public.agent_missions`, and (if anything shipped or was escalated)
one entry in `CLAUDE.md`'s "Recent work log" or "Pending / not yet
applied". Each division's own `SKILL.md` has repeated this boilerplate
inline — this file is the one place to keep it, so a schema change or a
formatting fix only needs to happen once. Reference this file from a
division's `SKILL.md` instead of re-deriving the pattern.

This is not a division of its own — it has no entry in
`agent_missions.division`'s CHECK constraint and isn't invocable via the
`Skill` tool. It's a shared convention any division (or a sub-agent
dispatched by one) follows directly.

## Logging a mission

```sql
-- At the start of a run (optional — only if the run is long enough that
-- a human might check progress mid-flight):
insert into public.agent_missions (division, goal, scope, outcome)
values ('<division>', 'short description of this run''s goal',
        'what''s being checked/built', 'in_progress')
returning id;

-- At the end, always:
insert into public.agent_missions (division, goal, scope, outcome, value_tag, notes)
values ('<division>', 'short description of this run''s goal',
        'what was actually checked/built',
        'merged' | 'closed' | 'rejected' | 'escalated' | 'report_only',
        'security' | 'correctness' | 'drift' | 'content-accuracy' | 'growth' | 'finance',
        'one or two sentences: what was found, what shipped (if anything), PR link if any');
```

`outcome` is one of the 6 values the CHECK constraint already allows
(`in_progress`/`merged`/`closed`/`rejected`/`escalated`/`report_only`).
A clean run that found nothing still gets a row — `report_only` — same as
every sweep in this project's history. Pick `value_tag` from the existing
set when it fits; adding a new one is fine but mention it in the PR so
the next division knows it exists.

**Known quirk, several divisions have hit this independently**: a direct
`execute_sql` `UPDATE`/`DELETE` against this table intermittently returns
`{"status":"cancelled"}` with no row actually changed. If an update to a
mission row silently doesn't stick, retry once or two; if it keeps
failing, note it in the PR rather than spending more attempts on it — the
insert itself (the row's existence) almost always succeeds even when a
follow-up update doesn't.

## CLAUDE.md entry format

Newest-first, at the top of "Recent work log" (or, for something not yet
fixed/decided, "Pending / not yet applied"):

```
- **<YYYY-MM-DD>** — **<one-line bolded summary of what happened>.**
  <Why this run happened — what triggered it.> <What was found, with the
  real evidence (a query result, a live test, a specific row).> <What
  shipped, if anything — PR number/link.> <Anything deliberately NOT done
  and why, if relevant — this project's standing convention is to say so
  explicitly rather than let a reader assume more was covered than was.>
```

Keep it to a few sentences unless the finding is genuinely complex enough
to need the fuller forensic detail this file's older entries sometimes
have — most entries don't need that length.

## Delegating legwork to a sub-agent ("research intern" pattern)

A division's own early steps are often pure data-gathering: run the SQL,
compile a table, no judgment involved yet. When a division is being run
directly in an interactive session (not firing unattended via its own
scheduled trigger), that legwork is a good candidate for a `fork` — it
keeps the division's own context focused on the judgment calls (drafting,
deciding fix-vs-escalate) instead of filling up with raw query output.
`site-guardian` already proves the next level of this out: it dispatches
4 parallel specialist sub-agents (`backend-reviewer`, `site-guardian-exploit`,
`site-guardian-drift`, `oracle`) for a sweep, then does the serialized
judgment work itself. Any division that outgrows a single pass (needs
several independent lines of investigation that don't depend on each
other) should copy that shape rather than inventing a new one — dispatch
the independent pieces in parallel via the `Agent` tool, keep the
aggregation/decision step single-threaded.
