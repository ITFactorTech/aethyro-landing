-- Allow referrers to read the events they generated.
-- Needed for the dashboard referral panel to show referral count.

CREATE POLICY "referrers can read own events"
  ON public.referral_events FOR SELECT
  USING (auth.uid() = referrer_user_id);
