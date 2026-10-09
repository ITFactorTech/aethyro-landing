-- Encrypts GitHub/Notion PATs at rest. `user_integrations.access_token` was
-- storing the plaintext token server-side -- the column's own original
-- comment even said so ("stored as-is (PAT or API key); encrypt at app
-- layer"), but that encryption was never actually implemented. Found
-- 2026-10-08 while fact-checking an external report's claim that
-- index.html said "nothing stored server-side" for these integrations --
-- the claim was false on two counts (the token *is* stored, and it was
-- stored as plaintext); the copy was fixed same day, this closes the real
-- gap underneath it. See CLAUDE.md's "Pending / not yet applied" section.
--
-- Table has 0 rows as of this migration (confirmed live) -- nobody has
-- connected GitHub/Notion yet -- but the USING clause below encrypts any
-- existing plaintext correctly regardless, so this is safe to re-apply
-- against a populated table too.

-- ── 1. Encryption key, same zero-policy app_secrets pattern as the HMAC
-- keys backing deletion/generation receipts (20260927040000, 20261006000000).
INSERT INTO public.app_secrets (key, value)
VALUES ('integration_token_encryption_key', encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- ── 2. Lock the table down to RPC-only access. `authenticated` currently
-- has full SELECT/INSERT/UPDATE/DELETE here (confirmed live via
-- has_table_privilege -- the same default-privileges-grant-is-a-floor
-- pattern this project has hit repeatedly: api_keys, routine_webhooks,
-- agent_missions). That let a signed-in user read their own token
-- directly via REST, bypassing both the intended service-role-only
-- design and the `connect` action's token-validation-via-real-API-call
-- step. The `integrations_own` RLS policy is left in place as a second
-- layer, but PostgREST checks the table grant first, so this revoke is
-- what actually closes the path.
REVOKE ALL ON public.user_integrations FROM anon, authenticated;

-- ── 3. access_token becomes bytea, holding pgp_sym_encrypt's output
-- directly. The USING clause encrypts any pre-existing plaintext with the
-- key just seeded above, so this statement is correct whether the table
-- is empty (as it is now) or not.
--
-- A USING "transform expression" disallows subqueries (confirmed live:
-- 0A000 "cannot use subquery in transform expression" when the key was
-- looked up inline via `(SELECT value FROM app_secrets WHERE ...)`).
-- Worked around by fetching the key into a transaction-local GUC first
-- (set_config(..., is_local := false), so it survives for the rest of
-- this migration's transaction) and reading it back via current_setting()
-- -- a plain function call, not a subquery -- inside the USING clause.
DO $$
DECLARE
  v_key text;
BEGIN
  SELECT value INTO v_key FROM public.app_secrets WHERE key = 'integration_token_encryption_key';
  PERFORM set_config('aethyro.tmp_integration_key', v_key, false);
END;
$$;

ALTER TABLE public.user_integrations
  ALTER COLUMN access_token TYPE bytea
  USING (
    CASE WHEN access_token IS NULL THEN NULL
    ELSE extensions.pgp_sym_encrypt(
      access_token,
      current_setting('aethyro.tmp_integration_key')
    )
    END
  );

COMMENT ON COLUMN public.user_integrations.access_token IS
  'PGP-symmetric-encrypted (pgp_sym_encrypt) with app_secrets.integration_token_encryption_key. Never read/written directly by client code or connector-proxy -- always through store_integration_token()/get_integration_token() below.';

COMMENT ON COLUMN public.user_integrations.refresh_token IS
  'Currently unused (github/notion PATs need no refresh). If a future provider needs this (the CHECK constraint already allows ''google''), encrypt it the same way access_token is encrypted here -- do not store it as plaintext.';

-- ── 4. store_integration_token: the only way a token is ever written.
-- Encrypts server-side before INSERT; the plaintext token never touches
-- a column directly from connector-proxy's own code.
--
-- auth.role() = 'service_role' is the right check here, not
-- auth.uid() = p_user_id -- this function's one and only legitimate
-- caller is connector-proxy's own supaAdmin (service-role) client, which
-- has already resolved and verified the real user via their own JWT
-- before calling this. auth.uid() is NULL for a service-role call with no
-- per-user JWT, so an ownership check written that way would raise
-- Forbidden for the function's only real caller -- the exact
-- get_credit_balance lesson this file's CLAUDE.md already documents.
CREATE OR REPLACE FUNCTION public.store_integration_token(
  p_user_id  uuid,
  p_provider text,
  p_token    text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT value INTO v_key FROM public.app_secrets WHERE key = 'integration_token_encryption_key';

  INSERT INTO public.user_integrations (user_id, provider, access_token, metadata)
  VALUES (p_user_id, p_provider, extensions.pgp_sym_encrypt(p_token, v_key), p_metadata)
  ON CONFLICT (user_id, provider) DO UPDATE
    SET access_token = excluded.access_token,
        metadata     = excluded.metadata;
END;
$$;

REVOKE ALL ON FUNCTION public.store_integration_token(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_integration_token(uuid, text, text, jsonb) TO service_role;

-- ── 5. get_integration_token: the only way a token is ever read back.
-- Returns NULL if no row exists (mirrors the previous `.select()` +
-- `integration?.access_token` falsy check connector-proxy already did).
CREATE OR REPLACE FUNCTION public.get_integration_token(
  p_user_id  uuid,
  p_provider text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key text;
  v_enc bytea;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT access_token INTO v_enc
  FROM public.user_integrations
  WHERE user_id = p_user_id AND provider = p_provider;

  IF v_enc IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value INTO v_key FROM public.app_secrets WHERE key = 'integration_token_encryption_key';
  RETURN extensions.pgp_sym_decrypt(v_enc, v_key);
END;
$$;

REVOKE ALL ON FUNCTION public.get_integration_token(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_integration_token(uuid, text) TO service_role;
