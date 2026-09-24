-- Persistent conversation history
-- Idempotent: tables, indexes, RLS, and trigger may already exist in production.

CREATE TABLE IF NOT EXISTS public.conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  title      text NOT NULL DEFAULT 'New conversation' CHECK (char_length(title) <= 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated ON public.conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_created ON public.messages (conversation_id, created_at ASC);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='users own their conversations'
  ) THEN
    CREATE POLICY "users own their conversations"
      ON public.conversations FOR ALL
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='users own their messages'
  ) THEN
    CREATE POLICY "users own their messages"
      ON public.messages FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.conversations
          WHERE id = conversation_id AND user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Trigger: bump conversations.updated_at when a message is inserted
CREATE OR REPLACE FUNCTION public.touch_conversation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  UPDATE public.conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_touch_conversation ON public.messages;
CREATE TRIGGER messages_touch_conversation
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_conversation();
