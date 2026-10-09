-- Diagnostic-only log of real purchase-funnel attempts: every time a
-- signed-in user with a valid pack selection invokes buy-credits, win or
-- lose. Built to answer a question this project has had no way to answer
-- for its entire history -- $0 lifetime revenue across 51 signups, with no
-- way to tell "nobody ever reaches checkout" apart from "people reach
-- checkout and abandon at Stripe" -- since GA4's checkout_started event
-- isn't queryable from a Claude session and Stripe itself isn't connected
-- here. Same zero-policy, service-role-only posture as admin_users/
-- agent_missions/testimonials: nothing here is read or written by any
-- client, only buy-credits' own service-role invocation.
CREATE TABLE public.purchase_funnel_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pack             text NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('success', 'error')),
  stripe_session_id text,
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX purchase_funnel_events_user_id_idx ON public.purchase_funnel_events(user_id);
CREATE INDEX purchase_funnel_events_created_at_idx ON public.purchase_funnel_events(created_at);

ALTER TABLE public.purchase_funnel_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchase_funnel_events FROM PUBLIC, anon, authenticated;
