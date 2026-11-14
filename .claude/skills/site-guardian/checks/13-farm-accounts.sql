-- Check: classify the farm / bot accounts by explicit, reproducible rules (read-only).
--
-- Replaces re-deriving "who is a farm" by hand every sweep (oracle, warden and the
-- cleanup scripts all need the same answer). Counts only -- no emails are selected.
-- Run with execute_sql. Last run 2026-11-14.
--
--   R1_confirmed_domain          the domains warden confirmed as scripted farming
--                                (keep in step with public.bonus_blocked_domains)
--   R2_gmail_first_of_group      the OLDEST account on a Gmail mailbox that has several
--                                (dots / +tag stripped, googlemail = gmail). Often a real
--                                person's working account: never delete on this rule.
--   R2_gmail_duplicate_of_older  the later accounts on that mailbox
--   R3_suspect_domain            single-account temp-mail domains, never adjudicated:
--                                listed for visibility only, do not act on them
--
-- 2026-11-14 baseline: R1 164 accounts (18,652 credits, 92 holding credits, 0 purchasers,
-- 3 with a stored conversation, 90 with API keys, 14 in referral events, last signup
-- 11-11); R2 11 duplicates + 2 firsts (2,278 credits); R3 4 accounts (807 credits).
with u as (
  select id, email, created_at, lower(split_part(email,'@',2)) as dom,
         case when lower(split_part(email,'@',2)) in ('gmail.com','googlemail.com')
              then replace(split_part(lower(split_part(email,'@',1)),'+',1),'.','') || '@gmail.com'
              else lower(email) end as norm
  from auth.users
), g as (
  select norm, count(*) c, min(created_at) first_at
  from u where dom in ('gmail.com','googlemail.com') group by norm having count(*) > 1
), cls as (
  select u.*,
    case
      when u.dom in ('fldubai.com','maxxspace.com','kuromee.com','nilufa.kuromee.com','voidash.cyou') then 'R1_confirmed_domain'
      when g.norm is not null and u.created_at <> g.first_at then 'R2_gmail_duplicate_of_older'
      when g.norm is not null and u.created_at = g.first_at then 'R2_gmail_first_of_group'
      when u.dom in ('onldm.net','skidder.wtf','gonrr.net','vietnam2.mail10p.com') then 'R3_suspect_domain'
    end as cls
  from u left join g on g.norm = u.norm
), f as (
  select c.*,
    coalesce((select sum(delta) from public.credit_ledger l where l.user_id=c.id),0) as bal,
    (select count(*) from public.credit_ledger l where l.user_id=c.id and l.reason='purchase') as purchases,
    (select count(*) from public.conversations v where v.user_id=c.id) as convs,
    (select count(*) from public.credit_ledger l where l.user_id=c.id and l.reason in ('chat_usage','api_usage','routine','agent_task')) as usage_rows,
    (select count(*) from public.api_keys k where k.user_id=c.id) as keys,
    (select count(*) from public.referral_events r where r.referrer_user_id=c.id or r.referee_user_id=c.id) as ref_events,
    (select count(*) from public.admin_users a where a.user_id=c.id) as is_admin,
    (select max(created_at) from public.credit_ledger l where l.user_id=c.id and l.delta < 0) as last_spend
  from cls c where c.cls is not null
)
select cls, count(*) accts, sum(bal) total_bal,
  sum((bal>0)::int) with_credits, sum((convs>0)::int) with_convs, sum((purchases>0)::int) purchasers,
  sum((keys>0)::int) with_keys, sum((ref_events>0)::int) in_referrals, sum((is_admin>0)::int) admins,
  sum(usage_rows) usage_rows, max(last_spend)::date last_spend, max(created_at)::date last_signup
from f group by cls order by cls;
-- CLEAN: counts at or below the baseline, last_signup not moving. A new last_signup on R1 means a
-- listed domain resumed (it should now get no bonus; confirm with the bonus rows of that day).
-- MISMATCH: an R1/R2 row with purchasers > 0 or admins > 0 -- STOP, that account is not a farm.
