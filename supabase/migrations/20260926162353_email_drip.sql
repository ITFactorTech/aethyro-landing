-- Email drip sequence state table.
-- Tracks which drip emails have been sent for each user so we can
-- gate the day-2 and day-5 sends without re-sending.

CREATE TABLE IF NOT EXISTS public.email_drip_state (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  welcome_sent_at      timestamptz,
  engagement_sent_at   timestamptz,
  reengagement_sent_at timestamptz,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.email_drip_state ENABLE ROW LEVEL SECURITY;

-- Only service role may read/write this table.
CREATE POLICY "service role only" ON public.email_drip_state
  USING (false) WITH CHECK (false);

-- Trigger: fire the welcome email via pg_net when a new user signs up.
-- pg_net posts to the send-welcome-email edge function asynchronously.
-- Requires: pg_net extension enabled (available on all Supabase projects).
CREATE OR REPLACE FUNCTION public.trigger_welcome_email()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  fn_url text;
  service_key text;
BEGIN
  fn_url     := current_setting('app.supabase_functions_url', true);
  service_key := current_setting('app.service_role_key', true);

  IF fn_url IS NOT NULL AND service_key IS NOT NULL THEN
    PERFORM net.http_post(
      url     := fn_url || '/send-welcome-email',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body    := jsonb_build_object(
        'user_id', NEW.id::text,
        'email',   NEW.email,
        'type',    'welcome'
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_welcome ON auth.users;
CREATE TRIGGER on_auth_user_created_welcome
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.trigger_welcome_email();

-- Daily pg_cron job: send day-2 engagement email to users who signed up
-- ≥2 days ago but haven't received the engagement email yet.
-- Runs at 09:05 UTC daily to spread load off the top of the hour.
SELECT cron.schedule(
  'drip-engagement',
  '5 9 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_functions_url') || '/send-welcome-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := jsonb_build_object(
      'user_id', u.id::text,
      'email',   u.email,
      'type',    'engagement'
    )
  )
  FROM auth.users u
  LEFT JOIN public.email_drip_state d ON d.user_id = u.id
  WHERE u.created_at <= now() - interval '2 days'
    AND (d.engagement_sent_at IS NULL)
    AND (d.welcome_sent_at IS NOT NULL OR u.created_at <= now() - interval '2 days')
  $$
);

-- Daily pg_cron job: send day-5 re-engagement email to users who signed up
-- ≥5 days ago, have no messages, and haven't received the reengagement email.
SELECT cron.schedule(
  'drip-reengagement',
  '15 9 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_functions_url') || '/send-welcome-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := jsonb_build_object(
      'user_id', u.id::text,
      'email',   u.email,
      'type',    'reengagement'
    )
  )
  FROM auth.users u
  LEFT JOIN public.email_drip_state d ON d.user_id = u.id
  WHERE u.created_at <= now() - interval '5 days'
    AND (d.reengagement_sent_at IS NULL)
  $$
);
