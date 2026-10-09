-- Public conversation sharing
-- Adds share_token to conversations; shared convs + messages readable anonymously.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS share_token uuid UNIQUE DEFAULT NULL;

CREATE INDEX IF NOT EXISTS conversations_share_token ON public.conversations (share_token)
  WHERE share_token IS NOT NULL;

-- Anon policy: read a conversation if they know the share token
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='conversations' AND policyname='anon can read shared conversations'
  ) THEN
    CREATE POLICY "anon can read shared conversations"
      ON public.conversations FOR SELECT
      TO anon
      USING (share_token IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='messages' AND policyname='anon can read shared messages'
  ) THEN
    CREATE POLICY "anon can read shared messages"
      ON public.messages FOR SELECT
      TO anon
      USING (
        EXISTS (
          SELECT 1 FROM public.conversations
          WHERE id = conversation_id AND share_token IS NOT NULL
        )
      );
  END IF;
END $$;
