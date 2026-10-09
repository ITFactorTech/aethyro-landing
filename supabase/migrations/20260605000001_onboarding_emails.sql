-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- Scheduled onboarding emails table
create table if not exists public.scheduled_emails (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  email       text not null,
  first_name  text,
  email_num   int not null,
  send_at     timestamptz not null,
  sent        boolean not null default false,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
)

create index if not exists scheduled_emails_due_idx
  on public.scheduled_emails(send_at) where sent = false

alter table public.scheduled_emails enable row level security

-- Service role only — users never read/write this directly
create policy "service only" on public.scheduled_emails
  using (false) with check (false)

-- Trigger: on new signup, queue all 5 emails
create or replace function public.queue_onboarding_emails()
returns trigger language plpgsql security definer as $$
declare
  fname text;
begin
  fname := coalesce(
    new.raw_user_meta_data->>'first_name',
    new.raw_user_meta_data->>'full_name',
    split_part(new.email, '@', 1)
  );

  insert into public.scheduled_emails (user_id, email, first_name, email_num, send_at) values
    (new.id, new.email, fname, 1, now()),                        -- immediate
    (new.id, new.email, fname, 2, now() + interval '1 day'),
    (new.id, new.email, fname, 3, now() + interval '3 days'),
    (new.id, new.email, fname, 4, now() + interval '7 days'),
    (new.id, new.email, fname, 5, now() + interval '12 days');

  return new;
end;
$$

drop trigger if exists on_auth_user_created_queue_emails on auth.users

create trigger on_auth_user_created_queue_emails
  after insert on auth.users
  for each row execute function public.queue_onboarding_emails()

-- pg_cron: every 30 minutes, send due emails via Edge Function
-- Marks sent=true atomically in CTE before firing HTTP (prevents double-send)
select cron.schedule(
  'send-onboarding-emails',
  '*/30 * * * *',
  $$
  with due as (
    update public.scheduled_emails
    set sent = true, sent_at = now()
    where send_at <= now() and sent = false
    returning email, first_name, email_num
  )
  select net.http_post(
    url     := 'https://uzmdqbtflcpikjdrggqc.supabase.co/functions/v1/send-onboarding-email',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bWRxYnRmbGNwaWtqZHJnZ3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODQxOTgsImV4cCI6MjA5MTI2MDE5OH0.BwNVBJCbw9SG-ge7PfmoIW8q_33k-ZQlqpDHa2HrvHI"}'::jsonb,
    body    := jsonb_build_object('email', d.email, 'first_name', d.first_name, 'email_num', d.email_num)
  ) from due d;
  $$
)