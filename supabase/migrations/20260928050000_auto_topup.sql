-- Auto-topup (opt-in): when a user's balance drops below the existing
-- low-credit threshold, automatically charge their saved payment method for
-- a chosen pack size instead of just emailing a low-balance warning. Off by
-- default; the user opts in from dashboard.html by saving a card via a
-- Stripe Checkout "setup" session (setup-auto-topup edge function), which
-- stripe-webhook's checkout.session.completed handler turns into
-- auto_topup_enabled = true once the card is actually confirmed.

ALTER TABLE public.profiles
  ADD COLUMN auto_topup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_topup_pack text,
  ADD COLUMN stripe_payment_method_id text,
  ADD COLUMN auto_topup_last_attempt_at timestamptz;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_auto_topup_pack_check
  CHECK (auto_topup_pack IS NULL OR auto_topup_pack IN ('starter', 'value', 'power', 'pro_7k'));

-- The client may freely toggle auto_topup_enabled off (a direct, no-round-trip
-- kill switch matters more here than anywhere else in this schema) and choose
-- auto_topup_pack (bounded by the CHECK above and re-validated server-side
-- against the real CREDIT_PACKS allowlist before anything is ever charged) --
-- but NEVER stripe_payment_method_id or auto_topup_last_attempt_at, which
-- only stripe-webhook and auto-topup-charge (both service-role, which bypasses
-- grants/RLS entirely) may set. Turning auto_topup_enabled on via a direct
-- client write without ever completing the setup-auto-topup flow is harmless:
-- the charge attempt just no-ops when stripe_payment_method_id is null.
GRANT UPDATE (auto_topup_enabled, auto_topup_pack) ON public.profiles TO authenticated;

-- Unrelated fix, found live while checking this table's existing grants for a
-- pattern to follow: `authenticated` never had UPDATE on workspace_context,
-- memory, or updated_at, despite chat.html's Workspace Context save
-- (~line 1542) and per-entry structured-memory delete (~line 2361) both
-- calling supabase.from('profiles').update({...}) directly from the client.
-- Both have been silently 42501'ing in production ("permission denied for
-- table profiles") since whichever session shipped them -- confirmed live
-- with a throwaway account's real session token before writing this fix.
GRANT UPDATE (workspace_context, memory, updated_at) ON public.profiles TO authenticated;
