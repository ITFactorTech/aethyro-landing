-- Shared-conversation links (app/share.html) never worked for anyone but the owner:
-- the 2026-10-09 migration added anon SELECT *policies* on conversations/messages but
-- anon holds no SELECT *grant* on either table, so PostgREST returned 42501 for every
-- logged-out visitor (and a signed-in non-owner has no policy for shared rows at all).
-- Granting anon SELECT is NOT the fix: those policies only test `share_token IS NOT NULL`,
-- so they would let anyone enumerate every shared conversation without knowing a token.
-- Instead: one SECURITY DEFINER read path keyed on the unguessable token, and drop the
-- two dead policies so a future broad GRANT cannot silently expose rows.

DROP POLICY IF EXISTS "anon can read shared conversations" ON public.conversations;
DROP POLICY IF EXISTS "anon can read shared messages" ON public.messages;

CREATE OR REPLACE FUNCTION public.get_shared_conversation(p_token uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  select jsonb_build_object(
    'title', c.title,
    'created_at', c.created_at,
    'messages', coalesce(
      (select jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content, 'created_at', m.created_at)
                        order by m.created_at)
         from public.messages m where m.conversation_id = c.id),
      '[]'::jsonb))
  from public.conversations c
  where c.share_token = p_token
$$;

REVOKE ALL ON FUNCTION public.get_shared_conversation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_conversation(uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_shared_conversation(uuid) IS
  'Public read path for app/share.html: returns {title, created_at, messages[]} for the one conversation whose share_token matches, else NULL. The token is the capability; there is no way to list tokens.';
