-- Feature: verifiable deletion receipts. Backs the "your data is never
-- sold" pledge with something a user can hold onto: deleting a conversation
-- (and its associated memory) returns an HMAC-SHA256-signed receipt proving
-- deletion happened, at that time, for that content — not just a UI toast.

-- ── app_secrets: zero-policy locked table ───────────────────────────────────
-- Same pattern as admin_users (20260927020000_admin_users_table.sql): RLS
-- enabled with NO policies makes this completely unreachable from any client
-- role. Only a SECURITY DEFINER function (whose owner role bypasses RLS) or
-- direct SQL can read it.
CREATE TABLE public.app_secrets (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;

-- Seed a random 256-bit HMAC key, hex-encoded. Generated once; never sent to
-- any client, never logged.
INSERT INTO public.app_secrets (key, value)
VALUES ('deletion_receipt_hmac_key', encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- ── deletion_receipts ────────────────────────────────────────────────────────
CREATE TABLE public.deletion_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  title            text,
  message_count    int  NOT NULL DEFAULT 0,
  memory_count     int  NOT NULL DEFAULT 0,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  payload          jsonb NOT NULL,
  signature        text NOT NULL
);

ALTER TABLE public.deletion_receipts ENABLE ROW LEVEL SECURITY;

-- Owner can read their own receipts. No INSERT/UPDATE/DELETE policy for any
-- client role — receipts are only ever written by delete_conversation_with_receipt
-- (SECURITY DEFINER) below, and are never editable once issued.
CREATE POLICY "deletion_receipts_select_own" ON public.deletion_receipts
  FOR SELECT
  USING (auth.uid() = user_id);

-- ── delete_conversation_with_receipt ────────────────────────────────────────
-- Deletes a conversation's messages, its memory_embeddings, and the
-- conversation row itself (explicitly, regardless of FK cascade behavior),
-- then issues a signed receipt proving what was deleted and when.
CREATE OR REPLACE FUNCTION public.delete_conversation_with_receipt(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_title          text;
  v_message_count  int;
  v_memory_count   int;
  v_deleted_at     timestamptz := now();
  v_payload        jsonb;
  v_hmac_key       text;
  v_signature      text;
  v_receipt_id     uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT title INTO v_title
  FROM public.conversations
  WHERE id = p_conversation_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  SELECT count(*) INTO v_message_count
  FROM public.messages WHERE conversation_id = p_conversation_id;

  SELECT count(*) INTO v_memory_count
  FROM public.memory_embeddings
  WHERE user_id = auth.uid() AND conversation_id = p_conversation_id::text;

  DELETE FROM public.memory_embeddings
  WHERE user_id = auth.uid() AND conversation_id = p_conversation_id::text;

  DELETE FROM public.messages WHERE conversation_id = p_conversation_id;

  DELETE FROM public.conversations
  WHERE id = p_conversation_id AND user_id = auth.uid();

  v_payload := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id',         auth.uid(),
    'title',           v_title,
    'message_count',   v_message_count,
    'memory_count',    v_memory_count,
    'deleted_at',       to_char(v_deleted_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  SELECT value INTO v_hmac_key FROM public.app_secrets WHERE key = 'deletion_receipt_hmac_key';
  v_signature := encode(extensions.hmac(v_payload::text, v_hmac_key, 'sha256'), 'hex');

  INSERT INTO public.deletion_receipts
    (user_id, conversation_id, title, message_count, memory_count, deleted_at, payload, signature)
  VALUES
    (auth.uid(), p_conversation_id, v_title, v_message_count, v_memory_count, v_deleted_at, v_payload, v_signature)
  RETURNING id INTO v_receipt_id;

  RETURN jsonb_build_object(
    'receipt_id', v_receipt_id,
    'payload',    v_payload,
    'signature',  v_signature
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation_with_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_conversation_with_receipt(uuid) TO authenticated;

-- verify_deletion_receipt: lets a user (or anyone with a receipt_id they own)
-- re-derive the signature server-side and confirm it still matches — proves
-- the receipt wasn't forged or altered after issuance. Read-only, no secret
-- ever leaves the database.
CREATE OR REPLACE FUNCTION public.verify_deletion_receipt(p_receipt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row public.deletion_receipts%ROWTYPE;
  v_hmac_key  text;
  v_recomputed text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_row FROM public.deletion_receipts
  WHERE id = p_receipt_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found';
  END IF;

  SELECT value INTO v_hmac_key FROM public.app_secrets WHERE key = 'deletion_receipt_hmac_key';
  v_recomputed := encode(extensions.hmac(v_row.payload::text, v_hmac_key, 'sha256'), 'hex');

  RETURN jsonb_build_object(
    'valid',   v_recomputed = v_row.signature,
    'payload', v_row.payload,
    'signature', v_row.signature
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_deletion_receipt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_deletion_receipt(uuid) TO authenticated;
