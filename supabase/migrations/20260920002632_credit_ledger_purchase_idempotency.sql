-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- Prevent double-crediting if Stripe redelivers the same checkout.session.completed webhook.
create unique index credit_ledger_purchase_session_idx
  on public.credit_ledger (stripe_session_id)
  where reason = 'purchase';
