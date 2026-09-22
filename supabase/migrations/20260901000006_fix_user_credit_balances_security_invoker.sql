-- Fix Supabase security advisory: user_credit_balances was a SECURITY DEFINER view.
-- Setting security_invoker = true means the view runs as the calling role,
-- so RLS on credit_ledger is respected.

ALTER VIEW public.user_credit_balances SET (security_invoker = true);
