-- Emoji reactions for newsletter issues.
-- Counts are stored server-side; client deduplicates via localStorage.

CREATE TABLE public.newsletter_reactions (
  issue_slug text    NOT NULL,
  emoji      text    NOT NULL,
  count      integer NOT NULL DEFAULT 0,
  CONSTRAINT newsletter_reactions_pkey PRIMARY KEY (issue_slug, emoji),
  CONSTRAINT newsletter_reactions_emoji_check CHECK (emoji IN ('🔥','🧠','💡'))
);

ALTER TABLE public.newsletter_reactions ENABLE ROW LEVEL SECURITY;

-- Anyone (anon included) can read reaction counts
CREATE POLICY "reactions_select_all"
  ON public.newsletter_reactions FOR SELECT USING (true);

-- Direct writes are blocked; use the function below
CREATE POLICY "reactions_no_direct_write"
  ON public.newsletter_reactions FOR INSERT WITH CHECK (false);

-- Atomic upsert — callable by anon and authenticated users
CREATE OR REPLACE FUNCTION public.add_newsletter_reaction(p_slug text, p_emoji text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  IF p_emoji NOT IN ('🔥','🧠','💡') THEN
    RAISE EXCEPTION 'invalid emoji';
  END IF;
  INSERT INTO newsletter_reactions(issue_slug, emoji, count)
    VALUES(p_slug, p_emoji, 1)
    ON CONFLICT(issue_slug, emoji)
    DO UPDATE SET count = newsletter_reactions.count + 1
    RETURNING count INTO v_count;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.add_newsletter_reaction(text, text) TO anon, authenticated;
