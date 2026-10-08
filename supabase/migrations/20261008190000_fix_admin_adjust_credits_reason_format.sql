-- admin_adjust_credits has been silently unusable since it was written: it
-- inserts reason = 'admin:' || p_reason (e.g. 'admin:manual adjustment'),
-- but credit_ledger_reason_check only allows the bare literal
-- 'admin_adjustment' (among a fixed enum of other literals) -- every call
-- has always raised a 23514 check-constraint violation and aborted before
-- reaching the RETURN. Found live 2026-10-08 going to use this function for
-- a real goodwill credit grant. Same root-cause class this project has
-- already hit multiple times (run-routines/run-agent-task billing, see
-- CLAUDE.md) -- a reason value that doesn't match the CHECK constraint
-- literally, just with no caller around until now to surface the error.
-- Fixed by using the correct enum literal and moving the human-readable
-- reason text into metadata, matching every other ledger insert in this
-- schema (reason is a strict enum; free text belongs in metadata jsonb).
CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_user_id uuid,
  p_amount  integer,
  p_reason  text DEFAULT 'manual adjustment'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_new_balance bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_amount = 0 THEN
    RAISE EXCEPTION 'Amount must be non-zero';
  END IF;

  INSERT INTO credit_ledger (user_id, delta, reason, metadata)
  VALUES (p_user_id, p_amount, 'admin_adjustment', jsonb_build_object('note', coalesce(p_reason, 'manual adjustment')));

  SELECT coalesce(sum(delta), 0) INTO v_new_balance
  FROM credit_ledger WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok',          true,
    'user_id',     p_user_id,
    'delta',       p_amount,
    'new_balance', v_new_balance
  );
END;
$function$;
