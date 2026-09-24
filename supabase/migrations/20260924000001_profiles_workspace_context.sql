-- Adds workspace_context to the existing profiles table.
-- The column is injected into the Claude system prompt on every authenticated
-- chat request so Claude knows who the user is without re-explaining each time.
-- Existing RLS policies (SELECT/UPDATE where auth.uid() = id) already cover it.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS workspace_context text
  CHECK (char_length(workspace_context) <= 2000);
