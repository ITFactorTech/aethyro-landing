-- Fix: drip-reengagement's own WHERE clause never actually excluded users
-- who've already sent a message, despite the job's original comment
-- ("send day-5 re-engagement email to users who ... have no messages")
-- claiming it did. The real exclusion only ever lived inside
-- send-welcome-email's own runtime check (hasMessages), which correctly
-- no-ops the send but never writes back to email_drip_state for an
-- already-engaged user -- so reengagement_sent_at stays permanently NULL
-- for every user who has ever sent a single message, and the cron's own
-- SELECT re-matches them again every single day, forever.
--
-- Found live 2026-10-27 via the site-guardian daily sweep's 24h
-- error-log scan: a burst of 20 429s on send-welcome-email at 09:15:00,
-- exactly matching this job's schedule. Root-caused by checking who the
-- job actually targets: of 77 users matching the live WHERE clause, 73
-- already had real messages (confirmed via a live join against
-- conversations/messages) -- i.e. 73 of today's 73-call burst were
-- structurally guaranteed no-ops, re-dispatched for the Nth day in a
-- row, and large enough today to trip a platform-level edge-function
-- concurrency limit. Not a security or data-correctness bug (no wrong
-- email was ever sent -- send-welcome-email's own gate is correct), but
-- a real, growing-with-signups inefficiency that will keep tripping
-- this ceiling harder as the user base grows.
--
-- Fix: push the same conversations/messages exclusion send-welcome-email
-- already applies at runtime up into the cron dispatch's own WHERE
-- clause, so an already-engaged user is never re-selected again.
-- Verified live before committing: eligible-row count went from 77
-- (73 of which were already-engaged no-ops) to 4 (the real, genuinely
-- zero-message candidates) with this exact WHERE clause.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'drip-reengagement'),
  command := $cmd$
  SELECT net.http_post(
    url     := 'https://uzmdqbtflcpikjdrggqc.supabase.co/functions/v1/send-welcome-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bWRxYnRmbGNwaWtqZHJnZ3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODQxOTgsImV4cCI6MjA5MTI2MDE5OH0.BwNVBJCbw9SG-ge7PfmoIW8q_33k-ZQlqpDHa2HrvHI'
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
    AND d.reengagement_sent_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.conversations c
      JOIN public.messages m ON m.conversation_id = c.id
      WHERE c.user_id = u.id
    )
  $cmd$
);
