-- get_credit_balance RPC, credit_ledger index, user_credit_balances view,
-- trial_usage created_at column, and trial_usage day index.

CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT COALESCE(SUM(delta), 0)::integer
  FROM public.credit_ledger
  WHERE user_id = p_user_id;
$$;

CREATE INDEX IF NOT EXISTS credit_ledger_user_id_idx ON public.credit_ledger(user_id);

CREATE OR REPLACE VIEW public.user_credit_balances
WITH (security_invoker = true) AS
SELECT user_id, COALESCE(SUM(delta), 0)::integer AS balance
FROM public.credit_ledger
GROUP BY user_id;

ALTER TABLE public.trial_usage
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS trial_usage_day_idx
  ON public.trial_usage (ip_address, (created_at::date));
