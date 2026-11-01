-- Adds 'growth' (content/growth-marketing division, drafts-only, never
-- posts without explicit approval — see .claude/skills/growth/SKILL.md)
-- to the agent_missions division roster alongside
-- nexus/oracle/codex/avery/sentinel/support/forge/warden.
ALTER TABLE public.agent_missions DROP CONSTRAINT agent_missions_division_check;
ALTER TABLE public.agent_missions ADD CONSTRAINT agent_missions_division_check
  CHECK (division IN ('nexus','oracle','codex','avery','sentinel','support','forge','warden','growth'));
