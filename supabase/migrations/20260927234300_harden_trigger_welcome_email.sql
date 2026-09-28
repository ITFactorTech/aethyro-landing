-- Fixes two security-advisor findings on public.trigger_welcome_email()
-- (the on_auth_user_created_welcome trigger function), found by a
-- site-guardian sweep on 2026-09-27:
--
-- 1. function_search_path_mutable (WARN) -- the function had no `SET
--    search_path`, unlike every other SECURITY DEFINER function in this
--    project (handle_new_user() already sets `search_path TO ''`).
-- 2. anon/authenticated_security_definer_function_executable (WARN) -- as
--    a SECURITY DEFINER function with no argument-based overload
--    ambiguity, PostgREST auto-exposed it at /rest/v1/rpc/trigger_welcome_email,
--    executable by anyone, signed in or not. It's meant to run only as a
--    trigger (it references NEW, which only exists in trigger context), so
--    there's no legitimate reason for it to be directly callable via RPC.
--
-- Fix: add `SET search_path TO ''` (matching handle_new_user()'s pattern),
-- and revoke EXECUTE from PUBLIC (not just anon/authenticated -- both are
-- implicitly members of PUBLIC, so revoking only the named roles is a
-- no-op as long as PUBLIC itself still holds the grant; confirmed via
-- information_schema.routine_privileges before writing this comment).
--
-- Verified live: a real signup after this migration still produces a
-- successful net._http_response row ({"ok":true,"type":"welcome"}, 200) --
-- SECURITY DEFINER trigger execution runs as the function owner regardless
-- of caller privileges, so revoking PUBLIC/anon/authenticated does not
-- break the trigger itself. A direct anon RPC call to
-- /rest/v1/rpc/trigger_welcome_email now 404s, matching the pattern
-- already used for admin_users' RPCs in 20260927020000_admin_users_table.sql.

CREATE OR REPLACE FUNCTION public.trigger_welcome_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  PERFORM net.http_post(
    url     := 'https://uzmdqbtflcpikjdrggqc.supabase.co/functions/v1/send-welcome-email',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bWRxYnRmbGNwaWtqZHJnZ3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODQxOTgsImV4cCI6MjA5MTI2MDE5OH0.BwNVBJCbw9SG-ge7PfmoIW8q_33k-ZQlqpDHa2HrvHI'
    ),
    body    := jsonb_build_object(
      'user_id', NEW.id::text,
      'email',   NEW.email,
      'type',    'welcome'
    )
  );
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.trigger_welcome_email() FROM PUBLIC;
