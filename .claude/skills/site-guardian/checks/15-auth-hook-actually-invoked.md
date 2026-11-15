# Check: an Auth hook that "is on" must leave a `run_hook` line for every user creation

**First found by**: the 2026-11-15 `site-guardian` sweep (`backend-reviewer` raised it, the
orchestrator confirmed it in `auth_logs`). The 2026-11-14 anti-farming work switched on a
Supabase Auth "Before User Created" HTTP hook (`signup-gate`, a Cloudflare Turnstile
check) and recorded it as verified because the function's own log showed no refusal and no
fail-open line for a real sign-up. That is not evidence: `signup-gate` v1 logged nothing on
a successful verification, so a hook that works and a hook that Auth never calls looked
identical. Auth does log every hook invocation on its own side (`run_hook` lines in
`auth_logs`; the older `check-leaked-password` hook left one per sign-up and OAuth
callback on 11-14), so the answer was always one query away. The result of this
sweep's run, and what the owner was asked to check, are in the private mission row
`d763d8e7-9352-416c-adc3-8de18147b856`, not in this public file.

**The rule**: never accept "the hook is on" from a dashboard screenshot, an owner's word,
or the absence of refusals. Count invocations against user creations.

## Steps

1. User creations in the window (throwaways excluded), any provider:

```sql
select created_at, raw_app_meta_data->>'provider' as provider
from auth.users
where created_at > :'since' and email not like '%@example.com'
order by created_at;
```

2. Hook invocations in the same window (`query_logs`, source `auth_logs`; one line per
   invocation, with `hook` = the function URL, `path` = `/signup` or `/callback`, `success`,
   and `error`):

```sql
select timestamp, event_message
from logs
where source = 'auth_logs' and event_message ilike '%run_hook%'
  and timestamp > :'since'
order by timestamp
```

   Read the `hook` URL in each line: it must be `.../functions/v1/signup-gate` (or whatever
   the intended hook is). A line for a different function means the dashboard still points
   somewhere else (a Before User Created hook slot holds exactly one URL).

3. Match them. A refused sign-up leaves a hook line but no `auth.users` row, so hook lines
   >= user creations is normal; the reverse is the finding.

## What "clean" looks like

Every real user creation since the hook was enabled has a `run_hook` line for the intended
URL within about a second of `created_at`, `success` true. Once `signup-gate` v2 is
deployed it also writes `signup-gate: allowed (...)` to `function_logs`, a second
independent trace.

## What a mismatch looks like

User creations with no `run_hook` line at all: the hook is not enabled, not saved, or points
at a function that is not the gate. The widget may still render and produce tokens; nothing
verifies them, and a scripted sign-up gets an account and a bonus. Escalate to the owner
(the Hooks screen is dashboard-only; no tool in this repo can read or change it) and do
NOT try to settle it by creating an account: a tokenless direct sign-up leaves an account if
the hook is off, and `@example.com` addresses are rejected by Auth *before* the hook runs,
so they prove nothing either way.

## Related lessons

* A control whose success path logs nothing cannot be verified from its logs: add an
  allow-line (no email, no token) the day the control ships.
* `check-leaked-password` ran as the Before User Created hook on 11-14 morning (a fail-open
  no-op on the Free plan) even though CLAUDE.md said it was not wired: check what the
  dashboard actually holds before assuming a slot is empty.

## Last run

2026-11-15 07:58Z, window 2026-11-14 08:00Z to 2026-11-15 07:58Z (`query_logs` caps a window at
24 h): the step 2 query itself is verified to work (`ilike '%run_hook%'` on `auth_logs` returned
5 lines, all for the older `check-leaked-password` hook). The intended hook had no line for
either real sign-up in the window: MISMATCH, escalated to the owner (dashboard check). Details
are in the private mission row above.
