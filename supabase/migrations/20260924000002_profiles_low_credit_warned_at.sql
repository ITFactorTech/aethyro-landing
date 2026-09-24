-- Tracks when we last sent a low-credit warning email to a user.
-- Used by the send-low-credit-email edge function to enforce a 7-day cooldown
-- so users aren't spammed. Existing RLS (SELECT/UPDATE where auth.uid() = id) covers it.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS low_credit_warned_at timestamptz;
