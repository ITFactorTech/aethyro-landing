-- Ongoing real-testimonial collection, built after the user asked to turn a
-- one-off manual outreach (3-4 real engaged users, identified and emailed
-- personally) into a repeatable mechanism. Same anti-fabrication discipline
-- this project has held since the 2026-09-28 testimonials removal: nothing
-- here ever auto-publishes anything. A request fires once per user, at most
-- ever; a response only ever reaches "submitted" until a human admin
-- approves it in app/admin.html; actually putting an approved quote on the
-- site is still a separate, manual copy-into-index.html step.

CREATE TABLE public.testimonials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token         text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  content       text,
  display_name  text,
  consent       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','submitted','approved','rejected','published')),
  source        text NOT NULL DEFAULT 'auto_milestone',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT testimonials_user_id_key UNIQUE (user_id)
);

-- One request per user, ever -- enforced by the unique constraint above, not
-- just app-level logic, so a race between two near-simultaneous chat
-- completions can't double-insert (see request_testimonial_if_eligible's
-- ON CONFLICT DO NOTHING below).

-- Same zero-policy, RPC-only posture as admin_users/agent_missions: RLS
-- enabled with no policies for anon/authenticated, explicit REVOKE because
-- this project's default-privileges rule has repeatedly handed new tables a
-- broader grant than intended (api_keys, routine_webhooks, user_integrations
-- -- see CLAUDE.md's schema-gotchas section) unless revoked by name. Content
-- here is a real person's private feedback before they've consented to it
-- being shown anywhere, so it gets the same lockdown as anything else
-- containing a user's own words/PII -- reads and writes only ever go
-- through the RPCs/edge functions below, never direct table access.
ALTER TABLE public.testimonials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.testimonials FROM PUBLIC, anon, authenticated;

-- Checks whether a user has crossed the engagement bar (10+ messages, or
-- returned on a 2nd distinct calendar day) and has never been asked before;
-- if so, atomically claims the ask (via the unique constraint) and returns a
-- fresh token for the request email to link to. service_role-only -- this
-- function's one legitimate caller is chat/index.ts's finalize(), which has
-- already resolved the real user from their own JWT before calling it (the
-- same get_credit_balance lesson from 2026-10-02/03, applied up front this
-- time instead of discovered after the fact).
CREATE OR REPLACE FUNCTION public.request_testimonial_if_eligible(p_user_id uuid)
RETURNS TABLE(should_send boolean, request_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_msg_count int;
  v_days int;
  v_token text;
  v_inserted_token text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Cheap short-circuit for the overwhelming majority of calls (users
  -- already asked, or not yet eligible on a prior message) before the more
  -- expensive aggregate below.
  IF EXISTS (SELECT 1 FROM public.testimonials t WHERE t.user_id = p_user_id) THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  SELECT count(*), count(DISTINCT m.created_at::date)
    INTO v_msg_count, v_days
  FROM public.messages m
  JOIN public.conversations c ON c.id = m.conversation_id
  WHERE c.user_id = p_user_id AND m.role = 'user';

  IF v_msg_count < 10 AND v_days < 2 THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO public.testimonials (user_id, requested_at, token, status)
  VALUES (p_user_id, now(), v_token, 'pending')
  ON CONFLICT (user_id) DO NOTHING
  RETURNING token INTO v_inserted_token;

  IF v_inserted_token IS NULL THEN
    -- Lost a race against a concurrent call, or a row already existed.
    RETURN QUERY SELECT false, NULL::text;
  ELSE
    RETURN QUERY SELECT true, v_inserted_token;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_testimonial_if_eligible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_testimonial_if_eligible(uuid) TO service_role;

-- Records the actual response, looked up by the single-use token from the
-- email link -- never by a logged-in session, since the person clicking the
-- link may not be signed in on that device. Called only by the new
-- submit-testimonial edge function (service_role), which is the one that
-- validates the token shape/expiry story; this function just does the
-- write, idempotently (a second submit on an already-submitted token is a
-- no-op, not an overwrite, so nobody can clobber a prior real response).
CREATE OR REPLACE FUNCTION public.submit_testimonial_response(
  p_token text,
  p_content text,
  p_display_name text,
  p_consent boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_updated int;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  UPDATE public.testimonials
  SET content = p_content,
      display_name = NULLIF(trim(p_display_name), ''),
      consent = p_consent,
      submitted_at = now(),
      status = 'submitted'
  WHERE token = p_token
    AND submitted_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_testimonial_response(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_testimonial_response(text, text, text, boolean) TO service_role;

-- Admin-only read, same is_admin() gate as get_agent_missions/get_admin_users.
CREATE OR REPLACE FUNCTION public.get_testimonials(p_status text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_rows jsonb;
  v_counts jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT jsonb_agg(row ORDER BY (row->>'requested_at') DESC) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id',           t.id,
      'user_id',      t.user_id,
      'email',        u.email,
      'requested_at', to_char(t.requested_at, 'YYYY-MM-DD HH24:MI'),
      'submitted_at', to_char(t.submitted_at, 'YYYY-MM-DD HH24:MI'),
      'content',      t.content,
      'display_name', t.display_name,
      'consent',      t.consent,
      'status',       t.status
    ) AS row
    FROM public.testimonials t
    JOIN auth.users u ON u.id = t.user_id
    WHERE p_status IS NULL OR t.status = p_status
  ) s;

  SELECT jsonb_build_object(
    'requested', count(*) FILTER (WHERE status = 'pending'),
    'submitted', count(*) FILTER (WHERE status = 'submitted'),
    'approved',  count(*) FILTER (WHERE status IN ('approved','published')),
    'rejected',  count(*) FILTER (WHERE status = 'rejected'),
    'total',     count(*)
  ) INTO v_counts
  FROM public.testimonials;

  RETURN jsonb_build_object(
    'rows',   coalesce(v_rows, '[]'::jsonb),
    'counts', v_counts
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_testimonials(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_testimonials(text) TO authenticated;

-- Admin moderation action: approve or reject a submitted testimonial. Does
-- NOT publish anything to the live site by itself -- "approved" just means
-- it's cleared to be hand-copied into index.html in a future PR, same as
-- every other testimonial this project has ever shown (real, reviewed, and
-- added by a deliberate code change, never auto-rendered from this table).
CREATE OR REPLACE FUNCTION public.moderate_testimonial(p_id uuid, p_approve boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  UPDATE public.testimonials
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END
  WHERE id = p_id AND status = 'submitted';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.moderate_testimonial(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_testimonial(uuid, boolean) TO authenticated;
