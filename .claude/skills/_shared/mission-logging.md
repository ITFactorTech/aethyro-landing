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

## Division persona names (display only — never a rename)

Each standing division also has a human first name, used only as a
cosmetic label in conversation and in `app/admin.html`'s Team panel.
It is **not** a rename: the technical codename stays the only thing
that's actually load-bearing — `agent_missions.division`'s CHECK
constraint, every `SKILL.md` folder name, `nexus`'s own division map,
and every existing CLAUDE.md reference all keep using the codename
exactly as before. Decided 2026-11-02 ("thin persona layer", picked
over a full rename) after the user asked for each division to have a
human-type name to call it by.

| Codename   | Persona | Role                            |
|------------|---------|----------------------------------|
| `nexus`    | Dana    | orchestrator                    |
| `oracle`   | Iris    | growth & data strategy          |
| `codex`    | Cole    | backend-reviewer                |
| `avery`    | Avery   | visual design (already a name)  |
| `sentinel` | Sasha   | site-guardian                   |
| `support`  | Robin   | support-triage                  |
| `forge`    | Remy    | ad-hoc build, no fixed skill     |
| `warden`   | Casey   | fraud/abuse defense              |
| `growth`   | Taylor  | content & growth-marketing       |
| `ledger`   | Priya   | unit economics                  |
| `probe`    | Quinn   | live functional verification     |

A division may refer to itself by its persona name in conversation
("Quinn here, running the probe sweep...") — that's the whole point —
but still writes its own `agent_missions` row, PR text, commit
messages, and every file path using the codename, same as always.
Ephemeral sub-agents/specialists dispatched for one task
(`site-guardian-exploit`, a research-intern fork, any `general-purpose`
dispatch) do **not** get a persona name — they're spun up and discarded
per-task by design, unlike the 11 standing divisions above.

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
