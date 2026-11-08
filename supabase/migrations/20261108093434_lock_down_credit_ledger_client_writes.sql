-- credit_ledger is written only by service-role edge functions and the SECURITY DEFINER
-- functions grant_signup_bonus() / admin_adjust_credits() (owner postgres, unaffected by this).
-- This project's default-privileges rule had left anon and authenticated with
-- INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on the table; RLS (a SELECT-only policy)
-- was the only thing stopping a client write. A credit_ledger row with reason='purchase' now
-- unlocks the paid model tiers and API access, so keep the grant layer closed as well.
-- Clients only read this table (own rows via the "users can view their own ledger" policy and
-- the security_invoker view user_credit_balances), so authenticated keeps SELECT.
REVOKE ALL ON TABLE public.credit_ledger FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.credit_ledger FROM authenticated;
