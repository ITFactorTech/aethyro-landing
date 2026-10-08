# Support-triage — root-cause a real user report

You investigate one specific real user's complaint or report the way the
2026-10-08 Dj/Lee chat-quality investigation was actually done: pull their
real conversation/billing history first, root-cause the mechanism, then
fix or escalate — never guess from the paraphrase alone, and never assume
the user's description of what happened is complete or accurate without
checking it against real data.

## Process

1. **Identify the real account.** Get an email or user id from the report.
   Look them up directly (`profiles`, `auth.users`) — don't proceed on a
   paraphrase alone if a real account can be found.
2. **Pull their actual history relevant to the complaint** — `messages`
   joined through `conversations` for a chat-quality issue,
   `credit_ledger` for a billing issue, `generation_receipts` if a
   specific reply's cost/model is in question, `user_routines`/
   `routine_webhooks` for an automation issue. Read the real exchange, not
   just the user's summary of it — the Dj investigation found the actual
   mechanism (3 of 4 exchanges silently routed to Haiku mid-conversation)
   specifically because the real messages were pulled, not because the
   complaint itself named a cause.
3. **Root-cause the mechanism in code**, not just in behavior. "The answer
   was bad" isn't a root cause; "the auto-router classifies only the
   current message, blind to conversation history" is. Trace it to the
   actual function/line.
4. **Decide fix vs. escalate**, same split every other division in this
   project uses:
   - Small, confident, mechanical (a floor/guard, a missing check, a
     copy fix) → fix it, verify live with a throwaway account replaying
     the same failure shape (per the established pattern — redeploy
     `test-admin-setup`, use it, re-stub to 410 immediately after), open
     a draft PR, update `CLAUDE.md`'s recent-work-log.
   - Needs a product/scope decision, or the root cause is systemic
     (pricing, access control, a design call) → write it up with the real
     evidence and hand it to the user or to `codex`/`oracle` as
     appropriate, rather than shipping a unilateral fix.
5. **Consider real-world remediation**, not just the code fix, when a
   real user was actually inconvenienced — e.g. the goodwill-credit grant
   given to Dj alongside the routing fix. Only ever against the admin's
   own authority already established in this repo (direct `admin_adjust_credits`
   RPC call or equivalent), never a unilateral Stripe refund or other
   action outside what's already established as safe here.

## Hard boundaries

- **Never contact the real customer directly** (no email, no in-app
  message) — that's a human decision, not this skill's. Report findings
  and proposed remediation back to the user; let them decide whether/how
  to reach out.
- **Never touch a real account's data beyond what the investigation and
  an explicitly-approved remediation require.** No speculative cleanup,
  no unrelated adjustments.
- **Never guess a root cause without pulling the real data first.** If the
  real history doesn't reproduce or explain the complaint, say so plainly
  rather than inventing a plausible mechanism.
- Never merge your own PR or push to `main`.

## Output

A short root-cause writeup (what happened, the actual mechanism, the real
evidence pulled) followed by either a fixed-and-verified PR or a clearly
flagged escalation — matching the same report format every other division
in this repo already uses.
