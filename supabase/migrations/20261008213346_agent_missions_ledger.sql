-- Ledger for the "agent team" skills (nexus/oracle/codex/avery/sentinel/
-- support/forge) introduced this session. This is the honest version of the
-- "treasury" concept from the superagent-economy design doc the user shared:
-- a real record of what each division attempted and whether it paid off,
-- with no simulated currency -- a frontier model doesn't need bounty
-- shaping to try hard, but a human running this project does need to see
-- which kind of work is actually landing.
--
-- Written to directly via this session's own Supabase access (SQL/service
-- role), never through a client INSERT path -- there is deliberately no
-- public write surface. Reads go through get_agent_missions() below,
-- gated by is_admin() the same way every other admin RPC in this project
-- is (see 20260927020000_admin_users_table.sql).

CREATE TABLE public.agent_missions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  division    text NOT NULL CHECK (division IN ('nexus','oracle','codex','avery','sentinel','support','forge')),
  goal        text NOT NULL,
  scope       text,
  pr_url      text,
  outcome     text NOT NULL DEFAULT 'in_progress'
              CHECK (outcome IN ('in_progress','merged','closed','rejected','escalated','report_only')),
  value_tag   text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Same zero-policy, RPC-only posture as admin_users: RLS enabled with no
-- policies for anon/authenticated, and an explicit REVOKE because this
-- project's default-privileges rule has repeatedly handed new tables a
-- broader grant than intended (api_keys, routine_webhooks -- see
-- CLAUDE.md's schema-gotchas section) unless revoked by name.
ALTER TABLE public.agent_missions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_missions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_agent_missions(p_limit int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_missions jsonb;
  v_by_division jsonb;
  v_total int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT count(*) INTO v_total FROM public.agent_missions;

  SELECT jsonb_agg(row) INTO v_missions
  FROM (
    SELECT jsonb_build_object(
      'id',         m.id,
      'division',   m.division,
      'goal',       m.goal,
      'scope',      m.scope,
      'pr_url',     m.pr_url,
      'outcome',    m.outcome,
      'value_tag',  m.value_tag,
      'notes',      m.notes,
      'created_at', to_char(m.created_at, 'YYYY-MM-DD HH24:MI'),
      'updated_at', to_char(m.updated_at, 'YYYY-MM-DD HH24:MI')
    ) AS row
    FROM public.agent_missions m
    ORDER BY m.created_at DESC
    LIMIT p_limit
  ) t;

  SELECT jsonb_agg(row ORDER BY row->>'division') INTO v_by_division
  FROM (
    SELECT jsonb_build_object(
      'division', division,
      'total',    count(*),
      'merged',   count(*) FILTER (WHERE outcome = 'merged'),
      'rejected', count(*) FILTER (WHERE outcome IN ('rejected','closed'))
    ) AS row
    FROM public.agent_missions
    GROUP BY division
  ) t;

  RETURN jsonb_build_object(
    'total',       v_total,
    'missions',    coalesce(v_missions, '[]'::jsonb),
    'by_division', coalesce(v_by_division, '[]'::jsonb)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_agent_missions(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agent_missions(int) TO authenticated;
