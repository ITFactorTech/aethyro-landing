-- Multi-step routine chaining: item 2 of the automation-depth expansion
-- (item 1, webhook-triggered routines, is migration 20260928080000). Lets a
-- routine's completed output feed directly into a second routine as context,
-- turning a single scheduled prompt into a pipeline (e.g. "scrape + summarize"
-- then "draft an email from that summary") without the user gluing them
-- together by hand.
--
-- Self-referential FK, same table -- deliberately not a separate "routine_chains"
-- join table, since a routine chains to at most one next step (a linear
-- pipeline, not a DAG) and this keeps "what runs after this" a single visible
-- column on the routine itself.
ALTER TABLE public.user_routines
  ADD COLUMN next_routine_id uuid REFERENCES public.user_routines(id) ON DELETE SET NULL;

-- A routine whose next_routine_id points elsewhere is looked up by
-- run-routines after every successful completion -- index it.
CREATE INDEX idx_user_routines_next_routine_id ON public.user_routines (next_routine_id)
  WHERE next_routine_id IS NOT NULL;

-- Ownership + cycle-detection guard. Without this, a client bug (or a
-- forked-then-relinked routine) could chain a routine to one owned by
-- someone else, or chain A -> B -> A and have run-routines loop until it
-- hits MAX_CHAIN_DEPTH burning credits the whole way. Runs under the
-- caller's own RLS-scoped rights (no SECURITY DEFINER needed): the
-- ownership check either finds the target row under "routines_own" (own
-- row) or "routines_public_read" (someone else's public row, which still
-- correctly fails the explicit user_id match below), and the cycle walk
-- only ever needs to see the caller's own chain, which RLS already permits.
CREATE OR REPLACE FUNCTION public.enforce_routine_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

CREATE TRIGGER trg_enforce_routine_chain
  BEFORE INSERT OR UPDATE OF next_routine_id ON public.user_routines
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_routine_chain();
