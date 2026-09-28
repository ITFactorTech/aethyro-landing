-- Webhook-triggered routines: item 1 of the automation-depth expansion
-- (demand research showed workflow automation as the single most-requested
-- AI SaaS capability across every survey checked — see CLAUDE.md's
-- recent-work-log). Turns a routine from purely schedule-driven into
-- reactive: any external system that can make an HTTP request (GitHub
-- Actions, Zapier, IFTTT, a cron job elsewhere, a curl in a script) can
-- fire a routine immediately by hitting a per-routine URL with a secret
-- token, independent of its normal cron schedule.
--
-- Deliberately generic (a bearer token in the URL), not per-provider
-- signature verification (GitHub HMAC, Stripe signing, etc.) -- that's a
-- real v2 if a specific integration needs it; v1 covers the common case
-- of "let any system with the URL trigger this" the same way Zapier/IFTTT
-- catch hooks and GitHub's repository_dispatch already work.
CREATE TABLE public.routine_webhooks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id       uuid NOT NULL REFERENCES public.user_routines(id) ON DELETE CASCADE,
  token            text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_triggered_at timestamptz,
  trigger_count    int NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX routine_webhooks_routine_id_idx ON public.routine_webhooks (routine_id);
-- token is already indexed via its UNIQUE constraint -- the public trigger
-- function looks rows up by token, so this keeps that lookup fast.

ALTER TABLE public.routine_webhooks ENABLE ROW LEVEL SECURITY;

-- Ownership is derived from the routine, same pattern as agent_task_steps'
-- "steps_own" policy: no separate user_id column to keep in sync, no way
-- for it to drift from the routine's real owner.
CREATE POLICY routine_webhooks_own ON public.routine_webhooks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.user_routines
      WHERE id = routine_webhooks.routine_id AND user_id = auth.uid()
    )
  );

-- The owner can create/view/delete their own routine's webhook row directly
-- via RLS -- no edge function needed for that half. "Regenerate" is a
-- delete + re-insert client-side (token's DEFAULT re-generates it), so no
-- UPDATE grant is needed; last_triggered_at/trigger_count are only ever
-- written by webhook-routine-trigger under the service-role key, which
-- bypasses grants entirely. Only token is ever shown to the client; the
-- *consuming* endpoint looks it up with no RLS involved, since an external
-- caller has no Supabase session.
GRANT SELECT, INSERT, DELETE ON public.routine_webhooks TO authenticated;
