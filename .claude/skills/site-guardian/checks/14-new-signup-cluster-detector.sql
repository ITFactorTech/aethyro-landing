-- Check: detect a NEW farming wave from this window's signups (read-only).
--
-- The farms keep changing domain (fldubai -> maxxspace -> kuromee -> ...), so a blocklist is always one
-- wave behind. These rules catch the shape of a wave in the first hours instead. Run with execute_sql;
-- change the interval to the sweep window (default 48 hours). No emails are selected.
--
-- Rules (each row of the result names the rule, a key, and the count):
--   domain_burst      3+ signups on the same non-major mail domain in the window
--   gmail_mailbox     2+ signups on one normalized Gmail mailbox in the window
--   same_minute       3+ signups inside one calendar minute
--   self_labelled     signup metadata says utm_source = 'autoreg' (wave 2 of fldubai labelled itself)
--   keys_no_chat      accounts that minted an API key but never opened a conversation, by domain, 3+
with w as (
  select id, email, created_at, raw_user_meta_data,
         lower(split_part(email,'@',2)) as dom,
         case when lower(split_part(email,'@',2)) in ('gmail.com','googlemail.com')
              then replace(split_part(lower(split_part(email,'@',1)),'+',1),'.','') || '@gmail.com' end as gnorm
  from auth.users
  where created_at > now() - interval '48 hours'
    and email not like '%@example.com'          -- sweep throwaways
), major(dom) as (
  values ('gmail.com'),('googlemail.com'),('outlook.com'),('hotmail.com'),('live.com'),('yahoo.com'),('icloud.com'),
         ('me.com'),('proton.me'),('protonmail.com'),('qq.com'),('163.com'),('126.com'),('foxmail.com'),('msn.com'),('aol.com')
)
select 'domain_burst' as rule, dom as key, count(*) as n, min(created_at) as first_seen, max(created_at) as last_seen
from w where dom not in (select dom from major) group by dom having count(*) >= 3
union all
select 'gmail_mailbox', md5(gnorm), count(*), min(created_at), max(created_at)
from w where gnorm is not null group by gnorm having count(*) >= 2
union all
select 'same_minute', to_char(date_trunc('minute', created_at),'YYYY-MM-DD HH24:MI'), count(*), min(created_at), max(created_at)
from w group by date_trunc('minute', created_at) having count(*) >= 3
union all
select 'self_labelled', 'autoreg', count(*), min(created_at), max(created_at)
from w where raw_user_meta_data #>> '{signup_utm,utm_source}' = 'autoreg'
having count(*) > 0
union all
select 'keys_no_chat', dom, count(*), min(created_at), max(created_at)
from w where exists (select 1 from public.api_keys k where k.user_id = w.id)
        and not exists (select 1 from public.conversations c where c.user_id = w.id)
group by dom having count(*) >= 3
order by 1, 3 desc;
-- CLEAN: zero rows. A row is a LEAD, not proof: read the surrounding signups (domain history, bonus rows,
-- usage) before adding a domain to bonus_blocked_domains or telling the owner. Never act on a major-provider
-- domain; for gmail_mailbox the new bonus rule (one per mailbox) already withholds the second bonus.
