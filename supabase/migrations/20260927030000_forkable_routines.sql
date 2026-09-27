-- Feature: shareable/forkable agent routines ("GitHub for AI automations").
-- user_routines already has full owner CRUD via RLS policy "routines_own"
-- (ALL USING auth.uid() = user_id) — that's untouched. This adds an
-- opt-in public gallery on top: a routine's owner can flip is_public, and
-- any authenticated user can then read (but not write) that routine and
-- fork it into their own private copy via fork_routine().

ALTER TABLE public.user_routines
  ADD COLUMN is_public   boolean NOT NULL DEFAULT false,
  ADD COLUMN fork_count  int     NOT NULL DEFAULT 0,
  ADD COLUMN forked_from uuid    REFERENCES public.user_routines(id) ON DELETE SET NULL;

CREATE INDEX idx_user_routines_public ON public.user_routines (created_at DESC) WHERE is_public = true;

-- Additive SELECT policy: RLS policies for the same command are OR'd
-- together, so this only ever widens read access beyond the existing
-- "routines_own" ALL policy — it never narrows it, and never grants
-- INSERT/UPDATE/DELETE on someone else's routine.
CREATE POLICY "routines_public_read" ON public.user_routines
  FOR SELECT
  USING (is_public = true);

-- fork_routine: copies a public routine into the caller's own routines.
-- SECURITY DEFINER so it can bump fork_count on the source row (owned by
-- someone else) without needing a public UPDATE policy on user_routines.
CREATE OR REPLACE FUNCTION public.fork_routine(p_routine_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src public.user_routines%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_src FROM public.user_routines
  WHERE id = p_routine_id AND is_public = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Routine not found or not public';
  END IF;

  INSERT INTO public.user_routines (user_id, name, prompt, schedule, model, enabled, is_public, forked_from)
  VALUES (auth.uid(), v_src.name, v_src.prompt, v_src.schedule, v_src.model, false, false, v_src.id)
  RETURNING id INTO v_new_id;

  UPDATE public.user_routines SET fork_count = fork_count + 1 WHERE id = p_routine_id;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fork_routine(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fork_routine(uuid) TO authenticated;
