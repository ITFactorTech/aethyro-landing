-- newsletter_index() and pack_index() only read public catalog data.
-- No reason for SECURITY DEFINER — switch to SECURITY INVOKER to clear
-- the Supabase security advisor warning.

CREATE OR REPLACE FUNCTION public.newsletter_index()
RETURNS TABLE(slug text, title text, summary text, is_premium boolean, published_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT slug, title, summary, is_premium, published_at
  FROM public.newsletter_issues ORDER BY published_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.pack_index()
RETURNS TABLE(pack_key text, title text, summary text, price_cents integer, is_free boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT pack_key, title, summary, price_cents, is_free
  FROM public.pack_content ORDER BY is_free DESC, price_cents, title;
$$;
