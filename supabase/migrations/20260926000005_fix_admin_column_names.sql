-- Fix admin functions: credit_ledger uses 'reason' not 'note',
-- and messages has no user_id column (must join via conversations).

-- ── 1. get_admin_stats ────────────────────────────────────────────────────────
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
  v_active_users_7d int;
  v_paid_users int;
  v_total_messages bigint;
  v_messages_7d bigint;
  v_avg_msgs_per_user numeric;
  v_total_conversations bigint;
  v_credits_issued bigint;
  v_credits_consumed bigint;
  v_revenue numeric;
  v_drip_welcome int;
  v_drip_engagement int;
  v_drip_reengagement int;
  v_signups_by_day jsonb;
  v_messages_by_day jsonb;
  v_top_users jsonb;
BEGIN
  caller_email := auth.jwt() ->> 'email';
  IF caller_email IS DISTINCT FROM 'leer4030@gmail.com' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT count(*) INTO v_total_users FROM auth.users;
  SELECT count(*) INTO v_users_7d  FROM auth.users WHERE created_at >= now() - interval '7 days';
  SELECT count(*) INTO v_users_30d FROM auth.users WHERE created_at >= now() - interval '30 days';

  -- Active = sent at least 1 user message in last 7 days (join via conversations)
  SELECT count(DISTINCT c.user_id) INTO v_active_users_7d
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.created_at >= now() - interval '7 days' AND m.role = 'user';

  -- Paid = at least one pack purchase in credit_ledger (column is 'reason')
  SELECT count(DISTINCT user_id) INTO v_paid_users
  FROM credit_ledger WHERE delta > 0 AND reason LIKE 'pack:%';

  SELECT count(*) INTO v_total_messages FROM messages;
  SELECT count(*) INTO v_messages_7d  FROM messages WHERE created_at >= now() - interval '7 days' AND role = 'user';

  SELECT CASE WHEN v_total_users > 0
    THEN round(v_total_messages::numeric / v_total_users, 1) ELSE 0 END
  INTO v_avg_msgs_per_user;

  SELECT count(*) INTO v_total_conversations FROM conversations;

  SELECT
    coalesce(sum(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0),
    coalesce(sum(CASE WHEN delta < 0 THEN abs(delta) ELSE 0 END), 0)
  INTO v_credits_issued, v_credits_consumed
  FROM credit_ledger;

  -- Revenue estimate from pack purchases (reason column)
  SELECT coalesce(sum(
    CASE reason
      WHEN 'pack:starter' THEN 4
      WHEN 'pack:value'   THEN 10
      WHEN 'pack:power'   THEN 30
      WHEN 'pack:pro_7k'  THEN 90
      ELSE 0
    END
  ), 0) INTO v_revenue
  FROM credit_ledger WHERE delta > 0 AND reason LIKE 'pack:%';

  SELECT count(*) INTO v_drip_welcome      FROM email_drip_state WHERE welcome_sent_at IS NOT NULL;
  SELECT count(*) INTO v_drip_engagement   FROM email_drip_state WHERE engagement_sent_at IS NOT NULL;
  SELECT count(*) INTO v_drip_reengagement FROM email_drip_state WHERE reengagement_sent_at IS NOT NULL;

  SELECT jsonb_agg(row ORDER BY row->>'date') INTO v_signups_by_day
  FROM (
    SELECT jsonb_build_object('date', to_char(created_at::date, 'YYYY-MM-DD'), 'count', count(*)) AS row
    FROM auth.users WHERE created_at >= now() - interval '30 days'
    GROUP BY created_at::date
  ) t;

  SELECT jsonb_agg(row ORDER BY row->>'date') INTO v_messages_by_day
  FROM (
    SELECT jsonb_build_object('date', to_char(created_at::date, 'YYYY-MM-DD'), 'count', count(*)) AS row
    FROM messages WHERE created_at >= now() - interval '30 days' AND role = 'user'
    GROUP BY created_at::date
  ) t;

  SELECT jsonb_agg(row ORDER BY (row->>'consumed')::bigint DESC) INTO v_top_users
  FROM (
    SELECT jsonb_build_object(
      'user_id', cl.user_id,
      'email',   u.email,
      'consumed', sum(CASE WHEN cl.delta < 0 THEN abs(cl.delta) ELSE 0 END),
      'balance',  sum(cl.delta),
      'messages', (
        SELECT count(*) FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = cl.user_id AND m.role = 'user'
      ),
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
      'total',    v_total_users,
      'last_7d',  v_users_7d,
      'last_30d', v_users_30d,
      'active_7d', v_active_users_7d,
      'paid',      v_paid_users
    ),
    'messages', jsonb_build_object(
      'total',        v_total_messages,
      'last_7d',      v_messages_7d,
      'avg_per_user', v_avg_msgs_per_user
    ),
    'conversations', v_total_conversations,
    'credits', jsonb_build_object(
      'issued',   v_credits_issued,
      'consumed', v_credits_consumed,
      'net',      v_credits_issued - v_credits_consumed
    ),
    'revenue', v_revenue,
    'drip', jsonb_build_object(
      'welcome',      v_drip_welcome,
      'engagement',   v_drip_engagement,
      'reengagement', v_drip_reengagement
    ),
    'signups_by_day',  coalesce(v_signups_by_day,  '[]'::jsonb),
    'messages_by_day', coalesce(v_messages_by_day, '[]'::jsonb),
    'top_users',       coalesce(v_top_users,       '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_stats() TO authenticated;

-- ── 2. get_admin_users ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_admin_users(
  p_page   int  DEFAULT 1,
  p_limit  int  DEFAULT 25,
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  caller_email text;
  v_offset int;
  v_total  int;
  v_users  jsonb;
BEGIN
  caller_email := auth.jwt() ->> 'email';
  IF caller_email IS DISTINCT FROM 'leer4030@gmail.com' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  v_offset := greatest(0, p_page - 1) * p_limit;

  SELECT count(*) INTO v_total
  FROM auth.users u
  WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%';

  SELECT jsonb_agg(row) INTO v_users
  FROM (
    SELECT jsonb_build_object(
      'user_id',         u.id::text,
      'email',           u.email,
      'joined',          to_char(u.created_at, 'YYYY-MM-DD'),
      'provider',        coalesce(u.raw_app_meta_data ->> 'provider', 'email'),
      'messages',        (
        SELECT count(*) FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = u.id AND m.role = 'user'
      ),
      'conversations',   (SELECT count(*) FROM conversations c WHERE c.user_id = u.id),
      'credits_balance', (SELECT coalesce(sum(delta), 0) FROM credit_ledger cl WHERE cl.user_id = u.id),
      'credits_consumed',(SELECT coalesce(sum(abs(delta)), 0) FROM credit_ledger cl WHERE cl.user_id = u.id AND cl.delta < 0),
      'is_paid',         (SELECT count(*) > 0 FROM credit_ledger cl WHERE cl.user_id = u.id AND cl.delta > 0 AND cl.reason LIKE 'pack:%'),
      'last_active',     (
        SELECT to_char(max(m.created_at), 'YYYY-MM-DD') FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = u.id AND m.role = 'user'
      )
    ) AS row
    FROM auth.users u
    WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%'
    ORDER BY u.created_at DESC
    LIMIT p_limit OFFSET v_offset
  ) t;

  RETURN jsonb_build_object(
    'users', coalesce(v_users, '[]'::jsonb),
    'total', v_total,
    'page',  p_page,
    'pages', CASE WHEN v_total = 0 THEN 1 ELSE ceil(v_total::numeric / p_limit) END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_users(int, int, text) TO authenticated;

-- ── 3. admin_adjust_credits (no change needed — uses user_id/delta only) ─────
-- Re-grant for completeness
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, int, text) TO authenticated;
