-- Extend the exact-domain blocklist with the other confirmed scripted-farming
-- domains (data only, no schema or function change).
--
-- Why: the blocklist drives three things -- the signup bonus is withheld, a
-- referral redeemed FROM a listed domain is refused, and (with the 2026-11-14
-- send-welcome-email v6) welcome / drip mails are not sent to it. Only fldubai.com
-- was listed; the older clusters below stopped signing up (last signups
-- 2026-10-26 .. 2026-10-31) but can resume, and the farms move domains rather
-- than stopping, so listing them costs nothing and removes the easy re-entry.
--
-- Evidence (live counts 2026-11-14): maxxspace.com 42 accounts, 0 conversations;
-- nilufa.kuromee.com 15 and kuromee.com 11, 0 conversations; voidash.cyou 4
-- accounts, scripted API-style usage. Each was adjudicated by warden (see the
-- CLAUDE.md entries of 2026-10-22, 2026-11-02). Exact match only: no subdomain,
-- no other domain, and no existing account's balance or data is touched.
INSERT INTO public.bonus_blocked_domains (domain, reason) VALUES
  ('maxxspace.com',
   'Scripted signup-bonus farming, 42 accounts hourly 2026-10-28..31, 0 stored conversations, closed referral loop; confirmed by warden 2026-11-02.'),
  ('kuromee.com',
   'Scripted signup-bonus farming, 11 accounts 2026-10-28..29, 0 stored conversations; confirmed by warden 2026-11-02.'),
  ('nilufa.kuromee.com',
   'Subdomain of kuromee.com, 15 accounts 2026-10-28..29, 0 stored conversations; confirmed by warden 2026-11-02.'),
  ('voidash.cyou',
   'Scripted API-style usage (100+ billed requests in 29 minutes from one account), test-harness local parts; confirmed by warden 2026-10-22.')
ON CONFLICT (domain) DO NOTHING;
