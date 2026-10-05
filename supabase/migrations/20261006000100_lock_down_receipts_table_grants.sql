-- Found live while building generation_receipts (same migration set): this
-- project's default-privileges rule auto-grants full ALL-table access to
-- anon/authenticated on every new table in public, and it turns out
-- deletion_receipts (shipped 2026-09-27) was never locked down either --
-- the exact same recurring over-grant class this file already documents
-- multiple times (api_keys, routine_webhooks, get_credit_balance, ...).
-- Not currently exploitable for either table (RLS denies INSERT/UPDATE/
-- DELETE by default wherever no policy exists for that command, and
-- neither table's SELECT policy is reachable for anon since auth.uid()
-- is null for that role), and chat.html never queries either table
-- directly -- both are only ever read/written through their SECURITY
-- DEFINER RPCs, whose function owner bypasses table grants entirely.
-- Revoking down to nothing for anon/authenticated on both tables costs
-- the client no functionality and removes the over-grant on principle,
-- consistent with every other instance of this class in this project.

REVOKE ALL ON public.deletion_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.generation_receipts FROM PUBLIC, anon, authenticated;
