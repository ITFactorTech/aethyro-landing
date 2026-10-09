-- Tracks when we last sent a "you're out of credits" email, separate from
-- low_credit_warned_at (which only fires for 1-30 credits remaining). A
-- single large reply can skip that 1-30 window entirely and land the
-- balance at 0 or negative in one shot -- found live 2026-10-05: a real
-- account went 47 -> -34 credits in one Opus reply and never received any
-- notification of any kind, warning or depleted, since low_credit_warned_at
-- never fires once the balance is <= 0. Own column so this new notification
-- never shares a cooldown with the existing warning email. Existing RLS
-- (SELECT/UPDATE where auth.uid() = id) covers it, same as
-- low_credit_warned_at's own migration.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS credits_depleted_warned_at timestamptz;
