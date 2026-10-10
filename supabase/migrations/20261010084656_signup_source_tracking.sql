-- Signup-source attribution. There is currently zero way to tell where a
-- real signup came from (an HN/Reddit post, a specific referral link, a
-- paid campaign, or organic/direct) except by inferring it after the fact
-- from message content and email-domain patterns -- see the 2026-10-10
-- cohort investigation in CLAUDE.md that had to do exactly that by hand.
-- Captured once, at signup, from client-supplied auth metadata -- never
-- client-writable after the fact (no UPDATE grant on these columns; only
-- this SECURITY DEFINER trigger, which bypasses grants, ever sets them).
alter table public.profiles
  add column signup_referrer text,
  add column signup_utm jsonb;

comment on column public.profiles.signup_referrer is
  'document.referrer captured client-side at signup (first-touch, from sessionStorage if the visitor arrived via index.html first). Null for OAuth signups -- signInWithOAuth has no metadata passthrough, a known gap, see CLAUDE.md.';
comment on column public.profiles.signup_utm is
  'Parsed utm_source/utm_medium/utm_campaign/utm_term/utm_content from the first-touch landing URL, as a jsonb object. Null if no UTM params were present. Same OAuth gap as signup_referrer.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.profiles (id, email, signup_referrer, signup_utm)
    values (
      new.id,
      new.email,
      new.raw_user_meta_data ->> 'signup_referrer',
      new.raw_user_meta_data -> 'signup_utm'
    )
    on conflict (id) do nothing;

  return new;
end;
$function$;
