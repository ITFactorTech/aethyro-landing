-- Phase 2 of the site-expansion pass: a public, metered API. Lets a user
-- call Aethyro's models from their own code (scripts, backend services, CI)
-- with a long-lived API key instead of a browser session, billed against
-- the same credit balance as chat.html (team-pool-aware, same as every
-- other credit_ledger-writing path in this codebase).
--
-- Revocation is delete, not a flag -- same pattern routine_webhooks already
-- uses for "regenerate" (delete + reinsert). A revoked key simply stops
-- being found by api-chat's lookup; there's no soft-revoked state to track.
CREATE TABLE public.api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text        NOT NULL DEFAULT 'API key',
  key_prefix    text        NOT NULL, -- first 16 chars of the plaintext key, shown in the UI so a user can tell keys apart without ever re-seeing the full secret
  key_hash      text        NOT NULL, -- sha256(plaintext), hex -- the plaintext itself is never stored
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  request_count bigint      NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX api_keys_key_hash_idx ON public.api_keys (key_hash);
CREATE INDEX api_keys_user_id_idx ON public.api_keys (user_id);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_own ON public.api_keys
  FOR ALL USING (auth.uid() = user_id);

-- Only SELECT (never key_hash -- SHA-256 is irreversible anyway, but there's
-- no reason to grant it) and DELETE (revoke) go to the client directly.
-- INSERT deliberately has no direct grant: a key's plaintext has to be
-- generated and hashed together, which only create_api_key() below does.
-- UPDATE has no grant either -- last_used_at/request_count are only ever
-- written by api-chat under the service role, which bypasses grants
-- entirely.
GRANT SELECT (id, name, key_prefix, created_at, last_used_at, request_count), DELETE
  ON public.api_keys TO authenticated;

-- create_api_key: generates a real key server-side, stores only its hash,
-- and returns the plaintext exactly once in the RPC response -- the same
-- "DB generates the secret" shape routine_webhooks' token DEFAULT uses,
-- just via a SECURITY DEFINER function instead of a column DEFAULT, since
-- the plaintext must never actually land in a stored column.
CREATE OR REPLACE FUNCTION public.create_api_key(p_name text DEFAULT NULL)
RETURNS TABLE(id uuid, name text, key_prefix text, plaintext_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_raw    text;
  v_hash   text;
  v_prefix text;
  v_name   text;
  v_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_raw    := 'ak_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_hash   := encode(extensions.digest(v_raw, 'sha256'), 'hex');
  v_prefix := left(v_raw, 16);
  v_name   := coalesce(nullif(trim(p_name), ''), 'API key');

  INSERT INTO public.api_keys (user_id, name, key_prefix, key_hash)
  VALUES (auth.uid(), v_name, v_prefix, v_hash)
  RETURNING api_keys.id INTO v_id;

  RETURN QUERY SELECT v_id, v_name, v_prefix, v_raw;
END;
$$;

REVOKE ALL ON FUNCTION public.create_api_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_api_key(text) TO authenticated;

-- api-chat bills with reason 'api_usage' -- same class of bug as the
-- routine/agent_task fix (20260928070000): a reason value the CHECK
-- constraint doesn't allow fails every insert silently unless the caller
-- checks the error, so it goes in the same migration as the feature that
-- introduces it, not a follow-up.
ALTER TABLE public.credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_reason_check
  CHECK (reason = ANY (ARRAY[
    'purchase'::text, 'chat_usage'::text, 'signup_bonus'::text,
    'admin_adjustment'::text, 'referral_bonus'::text,
    'routine'::text, 'agent_task'::text, 'api_usage'::text
  ]));
