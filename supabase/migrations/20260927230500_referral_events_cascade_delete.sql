-- Fixes: any account that has ever sent or redeemed a referral can never be
-- deleted via auth.admin.deleteUser() -- it hard-fails with "Database error
-- deleting user".
--
-- Root cause: referral_events' two FKs to auth.users (referrer_user_id,
-- referee_user_id) were created as NO ACTION, unlike every other user-owned
-- table in this schema (profiles, credit_ledger, conversations,
-- referral_codes, memory_embeddings, deletion_receipts all cascade).
-- Confirmed live via pg_constraint.confdeltype before writing this.
--
-- Fix: switch both to ON DELETE CASCADE. A referral_events row is a
-- historical record of a payout that already happened (the actual credits
-- live permanently in credit_ledger, reason='referral_bonus', and aren't
-- touched by this); it doesn't need to survive the user it names once that
-- user is gone, same as every other per-user table here.

alter table public.referral_events
  drop constraint referral_events_referrer_user_id_fkey,
  add constraint referral_events_referrer_user_id_fkey
    foreign key (referrer_user_id) references auth.users(id) on delete cascade;

alter table public.referral_events
  drop constraint referral_events_referee_user_id_fkey,
  add constraint referral_events_referee_user_id_fkey
    foreign key (referee_user_id) references auth.users(id) on delete cascade;
