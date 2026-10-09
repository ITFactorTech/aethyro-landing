-- Admin stats function: returns aggregated KPIs for the admin dashboard.
-- Caller must be authenticated as leer4030@gmail.com; all others get an error.

CREATE OR REPLACE FUNCTION public.get_admin_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
  v_total_users int;
  v_users_7d int;
  v_users_30d int;
  v_total_messages bigint;
  v_messages_7d bigint;
  v_total_conversations bigint;
  v_credits_issued bigint;
  v_credits_consumed bigint;
  v_drip_welcome int;
  v_drip_engagement int;
  v_drip_reengagement int;
  v_signups_by_day jsonb;
  v_messages_by_day jsonb;
  v_top_users jsonb;
BEGIN
  -- Auth gate
  caller_email := auth.jwt() ->> 'email';
  IF caller_email IS DISTINCT FROM 'leer4030@gmail.com' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- User counts
  SELECT count(*) INTO v_total_users FROM auth.users;
  SELECT count(*) INTO v_users_7d  FROM auth.users WHERE created_at >= now() - interval '7 days';
  SELECT count(*) INTO v_users_30d FROM auth.users WHERE created_at >= now() - interval '30 days';

  -- Message counts
  SELECT count(*) INTO v_total_messages FROM messages;
  SELECT count(*) INTO v_messages_7d  FROM messages WHERE created_at >= now() - interval '7 days' AND role = 'user';

  -- Conversation count
  SELECT count(*) INTO v_total_conversations FROM conversations;

  -- Credits
  SELECT
    coalesce(sum(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0),
    coalesce(sum(CASE WHEN delta < 0 THEN abs(delta) ELSE 0 END), 0)
  INTO v_credits_issued, v_credits_consumed
  FROM credit_ledger;

  -- Email drip funnel
  SELECT count(*) INTO v_drip_welcome      FROM email_drip_state WHERE welcome_sent_at IS NOT NULL;
  SELECT count(*) INTO v_drip_engagement   FROM email_drip_state WHERE engagement_sent_at IS NOT NULL;
  SELECT count(*) INTO v_drip_reengagement FROM email_drip_state WHERE reengagement_sent_at IS NOT NULL;

  -- Signups per day (last 30 days)
  SELECT jsonb_agg(row ORDER BY row->>'date')
  INTO v_signups_by_day
  FROM (
    SELECT jsonb_build_object(
      'date', to_char(created_at::date, 'YYYY-MM-DD'),
      'count', count(*)
    ) AS row
    FROM auth.users
    WHERE created_at >= now() - interval '30 days'
    GROUP BY created_at::date
  ) t;

  -- Messages per day (last 30 days, user messages only)
  SELECT jsonb_agg(row ORDER BY row->>'date')
  INTO v_messages_by_day
  FROM (
    SELECT jsonb_build_object(
      'date', to_char(created_at::date, 'YYYY-MM-DD'),
      'count', count(*)
    ) AS row
    FROM messages
    WHERE created_at >= now() - interval '30 days'
      AND role = 'user'
    GROUP BY created_at::date
  ) t;

  -- Top 10 users by credits consumed (most active spenders)
  SELECT jsonb_agg(row ORDER BY (row->>'consumed')::bigint DESC)
  INTO v_top_users
  FROM (
    SELECT jsonb_build_object(
      'user_id', cl.user_id,
      'email',   u.email,
      'consumed', sum(CASE WHEN cl.delta < 0 THEN abs(cl.delta) ELSE 0 END),
      'balance',  sum(cl.delta),
      'messages', (SELECT count(*) FROM messages m WHERE m.user_id = cl.user_id AND m.role = 'user'),
      'joined',   to_char(u.created_at, 'YYYY-MM-DD')
    ) AS row
    FROM credit_ledger cl
    JOIN auth.users u ON u.id = cl.user_id
    GROUP BY cl.user_id, u.email, u.created_at
    ORDER BY sum(CASE WHEN cl.delta < 0 THEN abs(cl.delta) ELSE 0 END) DESC
    LIMIT 10
  ) t;

  RETURN jsonb_build_object(
    'users', jsonb_build_object(
      'total', v_total_users,
      'last_7d', v_users_7d,
      'last_30d', v_users_30d
    ),
    'messages', jsonb_build_object(
      'total', v_total_messages,
      'last_7d', v_messages_7d
    ),
    'conversations', v_total_conversations,
    'credits', jsonb_build_object(
      'issued', v_credits_issued,
      'consumed', v_credits_consumed,
      'net', v_credits_issued - v_credits_consumed
    ),
    'drip', jsonb_build_object(
      'welcome', v_drip_welcome,
      'engagement', v_drip_engagement,
      'reengagement', v_drip_reengagement
    ),
    'signups_by_day', coalesce(v_signups_by_day, '[]'::jsonb),
    'messages_by_day', coalesce(v_messages_by_day, '[]'::jsonb),
    'top_users', coalesce(v_top_users, '[]'::jsonb)
  );
END;
$$;

-- Grant execute to authenticated users (the function gates by email internally)
GRANT EXECUTE ON FUNCTION public.get_admin_stats() TO authenticated;
