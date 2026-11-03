-- Day-6 "winback" email for users who activated (sent >=1 message) but never
-- came back on a later day. This is the main retention leak: ~50% of real
-- signups send a first message, but only 11 users have ever returned on a
-- second day. The existing drips don't cover this group: drip-engagement
-- (day 2) goes to everyone, drip-reengagement (day 5) only to users with
-- zero messages.
--
-- The WHERE clause mirrors send-welcome-email's runtime "winback" gate (which
-- re-checks everything and fails closed), and the function stamps
-- winback_sent_at whether or not it sends, so a user is selected at most
-- once (avoids the drip-reengagement daily-requery bug, fixed 2026-10-27).
-- The 30-day upper bound keeps the first run from emailing every
-- long-dormant account at once.

ALTER TABLE public.email_drip_state
  ADD COLUMN IF NOT EXISTS winback_sent_at timestamptz;

SELECT cron.schedule(
  'drip-winback',
  '25 9 * * *',
  $cmd$
  SELECT net.http_post(
    url     := 'https://uzmdqbtflcpikjdrggqc.supabase.co/functions/v1/send-welcome-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bWRxYnRmbGNwaWtqZHJnZ3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODQxOTgsImV4cCI6MjA5MTI2MDE5OH0.BwNVBJCbw9SG-ge7PfmoIW8q_33k-ZQlqpDHa2HrvHI'
    ),
    body    := jsonb_build_object('user_id', u.id::text, 'type', 'winback')
  )
  FROM auth.users u
  LEFT JOIN public.email_drip_state d ON d.user_id = u.id
  WHERE u.created_at <= now() - interval '6 days'
    AND u.created_at >  now() - interval '30 days'
    AND d.winback_sent_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.messages m ON m.conversation_id = c.id
      WHERE c.user_id = u.id AND m.role = 'user'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.messages m ON m.conversation_id = c.id
      WHERE c.user_id = u.id AND m.role = 'user'
        AND m.created_at >= u.created_at + interval '1 day'
    )
  $cmd$
);
