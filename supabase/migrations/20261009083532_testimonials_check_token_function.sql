-- Lets the public feedback-form page (app/feedback.html, via the
-- submit-testimonial edge function) show "invalid link" or "already used"
-- immediately on load, without exposing any row content or requiring a
-- throwaway submit attempt to find out. service_role-only, same posture as
-- the rest of this table's RPCs.
CREATE OR REPLACE FUNCTION public.check_testimonial_token(p_token text)
RETURNS TABLE(valid boolean, already_submitted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
    SELECT true, (t.submitted_at IS NOT NULL)
    FROM public.testimonials t
    WHERE t.token = p_token;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_testimonial_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_testimonial_token(text) TO service_role;
