-- request_testimonial_if_eligible's SET search_path TO 'public' excluded the
-- extensions schema, where pgcrypto (and gen_random_bytes/hmac) actually
-- live on this project -- found immediately via a direct-SQL test before
-- this ever reached a real chat request. Same schema-qualify + search_path
-- pattern generation_receipts/deletion_receipts already use for the same
-- reason (20261005224659_generation_receipts.sql).

CREATE OR REPLACE FUNCTION public.request_testimonial_if_eligible(p_user_id uuid)
RETURNS TABLE(should_send boolean, request_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
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

  v_token := encode(extensions.gen_random_bytes(24), 'hex');

  INSERT INTO public.testimonials (user_id, requested_at, token, status)
  VALUES (p_user_id, now(), v_token, 'pending')
  ON CONFLICT (user_id) DO NOTHING
  RETURNING token INTO v_inserted_token;

  IF v_inserted_token IS NULL THEN
    RETURN QUERY SELECT false, NULL::text;
  ELSE
    RETURN QUERY SELECT true, v_inserted_token;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.request_testimonial_if_eligible(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_testimonial_if_eligible(uuid) TO service_role;

-- Also fix the column default to schema-qualify, for consistency even
-- though every real insert path (the function above) always supplies its
-- own token explicitly and never relies on this default.
ALTER TABLE public.testimonials ALTER COLUMN token SET DEFAULT encode(extensions.gen_random_bytes(24), 'hex');
