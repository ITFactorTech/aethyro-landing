-- Auto-memory: structured JSONB column on profiles
-- Stores extracted facts about the user (name, occupation, projects, preferences, etc.)
-- Populated automatically by the chat edge function after each exchange.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS memory jsonb NOT NULL DEFAULT '{}'::jsonb;
