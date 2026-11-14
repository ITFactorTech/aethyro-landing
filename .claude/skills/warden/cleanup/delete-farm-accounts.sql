-- Farm cleanup, step 5 (optional, IRREVERSIBLE): delete dormant confirmed-farm accounts.
-- Not before 2026-12-14. Run in the Supabase SQL editor (cloud sessions cannot confirm deletes).
--
-- 0. Run zero-farm-credits.sql first, and keep a record: run the EXPORT below and download the
--    result as CSV before deleting anything.
-- 1. Rule: R1 confirmed domains only; no purchase, no admin row, no stored conversation; balance <= 0;
--    no usage in the last 30 days. Cascades remove the account's rows in every user-owned table
--    (verified on 2026-11-14 with seven throwaway accounts: zero orphans in 17 tables).
-- 2. Delete in batches (the LIMIT) and re-run until it affects 0 rows.

-- ── EXPORT (read-only): id, domain, signup date, balance, usage rows ─────────
with t as (
  select u.id, lower(split_part(u.email,'@',2)) as dom, u.created_at,
         coalesce((select sum(delta) from public.credit_ledger l where l.user_id = u.id), 0) as bal,
         (select count(*) from public.credit_ledger l where l.user_id = u.id and l.reason in ('chat_usage','api_usage','routine','agent_task')) as usage_rows
  from auth.users u
  where lower(split_part(u.email,'@',2)) in ('fldubai.com','maxxspace.com','kuromee.com','nilufa.kuromee.com','voidash.cyou')
    and not exists (select 1 from public.credit_ledger l where l.user_id = u.id and l.reason = 'purchase')
    and not exists (select 1 from public.admin_users a where a.user_id = u.id)
    and not exists (select 1 from public.conversations c where c.user_id = u.id)
    and not exists (select 1 from public.credit_ledger l where l.user_id = u.id and l.delta < 0 and l.created_at > now() - interval '30 days')
)
select * from t where bal <= 0 order by created_at;

-- ── THE DELETE (one batch of 50; repeat until 0 rows) ────────────────────────
-- delete from auth.users
-- where id in (
--   select id from ( <the same t CTE as above> ) t where bal <= 0 order by created_at limit 50
-- );
