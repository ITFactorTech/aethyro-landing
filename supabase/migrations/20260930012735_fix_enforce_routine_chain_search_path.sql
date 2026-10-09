-- site-guardian sweep 2026-09-30: get_advisors flagged enforce_routine_chain()
-- (the BEFORE INSERT OR UPDATE trigger on user_routines.next_routine_id that
-- rejects self-chains and cycles) for a mutable search_path -- unlike every
-- other function in this project, it never set one explicitly. Not
-- SECURITY DEFINER, so the practical risk is low (it already only ever
-- references fully-qualified public.user_routines), but every other function
-- here sets search_path explicitly and this one should too.
CREATE OR REPLACE FUNCTION public.enforce_routine_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_target_owner uuid;
  v_current      uuid;
  v_depth        int := 0;
BEGIN
  IF NEW.next_routine_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.next_routine_id = NEW.id THEN
    RAISE EXCEPTION 'A routine cannot chain to itself';
  END IF;

  SELECT user_id INTO v_target_owner
  FROM public.user_routines
  WHERE id = NEW.next_routine_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Chain target routine not found';
  END IF;

  IF v_target_owner <> NEW.user_id THEN
    RAISE EXCEPTION 'Cannot chain to a routine you do not own';
  END IF;

  -- Walk the chain forward from the proposed target; bail if it ever loops
  -- back to NEW.id, or after 20 hops as a sanity backstop.
  v_current := NEW.next_routine_id;
  WHILE v_current IS NOT NULL AND v_depth < 20 LOOP
    IF v_current = NEW.id THEN
      RAISE EXCEPTION 'Chaining this routine here would create a cycle';
    END IF;
    SELECT next_routine_id INTO v_current
    FROM public.user_routines WHERE id = v_current;
    v_depth := v_depth + 1;
  END LOOP;

  RETURN NEW;
END;
$function$;
