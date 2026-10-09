-- admin_adjust_credits still inserted into credit_ledger.note, which does not
-- exist (the real column is `reason`). Every call raised a Postgres error.
-- Sibling functions get_admin_stats/get_admin_users were fixed for this same
-- bug in 20260926000005_fix_admin_column_names.sql; that migration's comment
-- said this function needed "no change" — it did.

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
  caller_email text;
  v_new_balance bigint;
BEGIN
  caller_email := auth.jwt() ->> 'email';
  IF caller_email IS DISTINCT FROM 'leer4030@gmail.com' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_amount = 0 THEN
    RAISE EXCEPTION 'Amount must be non-zero';
  END IF;

  INSERT INTO credit_ledger (user_id, delta, reason)
  VALUES (p_user_id, p_amount, 'admin:' || coalesce(p_reason, 'manual adjustment'));

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

GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text) TO authenticated;
