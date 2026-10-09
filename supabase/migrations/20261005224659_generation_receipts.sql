-- Feature: verifiable generation receipts, the counterpart to the existing
-- deletion receipts (20260927040000_deletion_receipts.sql). Every billed
-- chat reply gets a tamper-evident, HMAC-SHA256-signed record of exactly
-- what produced it -- model, token counts, cost, and what context (tools,
-- memory, documents) fed into it -- that the user can hold onto and show
-- someone else as proof of what was AI-generated and from what, independent
-- of trusting a screenshot or the chat UI itself.

-- Own HMAC key, separate from deletion_receipt_hmac_key, so rotating one
-- receipt type's key can never silently invalidate the other's.
INSERT INTO public.app_secrets (key, value)
VALUES ('generation_receipt_hmac_key', encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

CREATE TABLE public.generation_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id  uuid,
  model            text NOT NULL,
  requested_model  text,
  input_tokens     int  NOT NULL DEFAULT 0,
  output_tokens    int  NOT NULL DEFAULT 0,
  credits          int  NOT NULL DEFAULT 0,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  payload          jsonb NOT NULL,
  signature        text NOT NULL
);

ALTER TABLE public.generation_receipts ENABLE ROW LEVEL SECURITY;

-- Owner can read their own receipts. No INSERT/UPDATE/DELETE policy for any
-- client role -- receipts are only ever written by create_generation_receipt
-- below, called internally by the chat edge function's service-role client,
-- and are never editable once issued.
CREATE POLICY "generation_receipts_select_own" ON public.generation_receipts
  FOR SELECT
  USING (auth.uid() = user_id);

-- ── create_generation_receipt ────────────────────────────────────────────
-- Called by chat's finalize() via the service-role client right after a
-- reply is billed -- never by a real user's own JWT, since the payload's
-- integrity depends on the edge function assembling it from data it just
-- computed itself (token counts, tool/retrieval usage), not on anything a
-- client could supply. Same lesson this repo already learned the hard way
-- with get_credit_balance/increment_rate_limit: a SECURITY DEFINER function
-- meant for exactly one internal caller checks auth.role() = 'service_role'
-- directly, with no auth.uid() branch to get wrong.
CREATE OR REPLACE FUNCTION public.create_generation_receipt(
  p_user_id         uuid,
  p_conversation_id uuid,
  p_model           text,
  p_requested_model text,
  p_input_tokens    int,
  p_output_tokens   int,
  p_credits         int,
  p_sources         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_generated_at timestamptz := now();
  v_payload      jsonb;
  v_hmac_key     text;
  v_signature    text;
  v_receipt_id   uuid;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  v_payload := jsonb_build_object(
    'user_id',          p_user_id,
    'conversation_id',  p_conversation_id,
    'model',            p_model,
    'requested_model',  p_requested_model,
    'input_tokens',     p_input_tokens,
    'output_tokens',    p_output_tokens,
    'credits',          p_credits,
    'sources',          coalesce(p_sources, '{}'::jsonb),
    'generated_at',     to_char(v_generated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  SELECT value INTO v_hmac_key FROM public.app_secrets WHERE key = 'generation_receipt_hmac_key';
  v_signature := encode(extensions.hmac(v_payload::text, v_hmac_key, 'sha256'), 'hex');

  INSERT INTO public.generation_receipts
    (user_id, conversation_id, model, requested_model, input_tokens, output_tokens, credits, generated_at, payload, signature)
  VALUES
    (p_user_id, p_conversation_id, p_model, p_requested_model, p_input_tokens, p_output_tokens, p_credits, v_generated_at, v_payload, v_signature)
  RETURNING id INTO v_receipt_id;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt_id,
    'payload',    v_payload,
    'signature',  v_signature
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_generation_receipt(uuid, uuid, text, text, int, int, int, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_generation_receipt(uuid, uuid, text, text, int, int, int, jsonb) TO service_role;

-- ── verify_generation_receipt ────────────────────────────────────────────
-- Mirrors verify_deletion_receipt exactly: lets the owning user re-derive
-- the signature server-side and confirm it still matches the stored
-- payload. Read-only, no secret ever leaves the database.
CREATE OR REPLACE FUNCTION public.verify_generation_receipt(p_receipt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row public.generation_receipts%ROWTYPE;
  v_hmac_key   text;
  v_recomputed text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_row FROM public.generation_receipts
  WHERE id = p_receipt_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found';
  END IF;

  SELECT value INTO v_hmac_key FROM public.app_secrets WHERE key = 'generation_receipt_hmac_key';
  v_recomputed := encode(extensions.hmac(v_row.payload::text, v_hmac_key, 'sha256'), 'hex');

  RETURN jsonb_build_object(
    'valid',     v_recomputed = v_row.signature,
    'payload',   v_row.payload,
    'signature', v_row.signature
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_generation_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_generation_receipt(uuid) TO authenticated;
