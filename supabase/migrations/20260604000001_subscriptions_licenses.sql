-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- Subscriptions table — tracks Stripe subscription state per user
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id   TEXT,
  stripe_subscription_id TEXT,
  plan                 TEXT NOT NULL DEFAULT 'trial',
  status               TEXT NOT NULL DEFAULT 'trialing',
  trial_ends_at        TIMESTAMPTZ DEFAULT (now() + interval '14 days'),
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id)
)

-- Licenses table — device activations per user
CREATE TABLE IF NOT EXISTS public.licenses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  device_label       TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  issued_at          TIMESTAMPTZ DEFAULT now(),
  expires_at         TIMESTAMPTZ DEFAULT (now() + interval '1 year'),
  UNIQUE (user_id, device_fingerprint)
)

-- RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY

CREATE POLICY "Users can view own subscription" ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id)

CREATE POLICY "Users can view own licenses" ON public.licenses
  FOR SELECT USING (auth.uid() = user_id)

-- Service role can do everything (needed by Edge Functions + webhook)
CREATE POLICY "Service role full access subscriptions" ON public.subscriptions
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')

CREATE POLICY "Service role full access licenses" ON public.licenses
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role')

-- Auto-create trial subscription on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status, trial_ends_at)
  VALUES (NEW.id, 'trial', 'trialing', now() + interval '14 days')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()