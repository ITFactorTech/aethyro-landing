-- Farm cleanup, step 1: remove the unspent credits from confirmed farm accounts.
-- REVERSIBLE: this INSERTS offsetting ledger rows and deletes nothing. Needs the owner's OK.
--
-- Scope (the same rules as checks/13-farm-accounts.sql):
--   * R1 confirmed-domain accounts and R2 Gmail duplicates of an older account
--   * NOT R2 "first of group" (often a real person), NOT R3 suspect domains
--   * skips any account with a purchase, an admin row, or a stored conversation
--     (those are reviewed by hand, never zeroed by a rule)
-- Why: ~20,000 credits sit unspent on accounts that exist only to farm the grant. Free usage
-- is Haiku-rate on Terra, so the worst case is about $1.25 per 100 credits, but nothing
-- should be spendable by an operator who comes back to a dormant account.
--
-- Run the DRY RUN first. Live dry run 2026-11-14: R1 89 accounts / 18,119 credits, R2_dup 10 accounts /
-- 1,800 credits (99 accounts, 19,919 credits in all; the accounts skipped for a stored conversation hold
-- the rest of the R1 / R2 balance).

-- ── DRY RUN (read-only) ──────────────────────────────────────────────────────
with u as (
  select id, created_at, lower(split_part(email,'@',2)) as dom,
         case when lower(split_part(email,'@',2)) in ('gmail.com','googlemail.com')
              then replace(split_part(lower(split_part(email,'@',1)),'+',1),'.','') || '@gmail.com'
              else lower(email) end as norm
  from auth.users
), g as (
  select norm, min(created_at) first_at from u
  where dom in ('gmail.com','googlemail.com') group by norm having count(*) > 1
), t as (
  select u.id,
    case when u.dom in ('fldubai.com','maxxspace.com','kuromee.com','nilufa.kuromee.com','voidash.cyou') then 'R1'
         when g.norm is not null and u.created_at <> g.first_at then 'R2_dup' end as rule,
    coalesce((select sum(delta) from public.credit_ledger l where l.user_id = u.id), 0) as bal
  from u left join g on g.norm = u.norm
)
select rule, count(*) as accounts, sum(bal) as credits_to_remove
from t
where rule is not null and bal > 0
  and not exists (select 1 from public.credit_ledger l where l.user_id = t.id and l.reason = 'purchase')
  and not exists (select 1 from public.admin_users a where a.user_id = t.id)
  and not exists (select 1 from public.conversations c where c.user_id = t.id)
group by rule order by rule;

-- ── THE CHANGE (run only after the dry run looks right) ─────────────────────
-- insert into public.credit_ledger (user_id, delta, reason, metadata)
-- select t.id, -t.bal, 'admin_adjustment',
--        jsonb_build_object('note', 'farm cleanup 2026-11-14: unspent credits removed (warden-confirmed farming)', 'rule', t.rule)
-- from ( <the same u / g / t CTEs as above> ) t
-- where t.rule is not null and t.bal > 0
--   and not exists (select 1 from public.credit_ledger l where l.user_id = t.id and l.reason = 'purchase')
--   and not exists (select 1 from public.admin_users a where a.user_id = t.id)
--   and not exists (select 1 from public.conversations c where c.user_id = t.id);
--
-- UNDO: insert the opposite sign for rows tagged with that note:
--   insert into public.credit_ledger (user_id, delta, reason, metadata)
--   select user_id, -delta, 'admin_adjustment', jsonb_build_object('note','undo farm cleanup 2026-11-14')
--   from public.credit_ledger where reason = 'admin_adjustment' and metadata->>'note' like 'farm cleanup 2026-11-14%';
