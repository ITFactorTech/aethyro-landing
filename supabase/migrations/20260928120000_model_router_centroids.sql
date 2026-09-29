-- Phase 3: smarter auto-model router. Stores the nearest-centroid classifier's
-- 3 reference vectors (light/medium/heavy) in the DB instead of as source-code
-- literals in chat/index.ts -- keeps that file small, and reuses the same
-- pgvector pattern memory_embeddings/document_chunks already use rather than
-- inventing a new one. Seeded via a follow-up set of INSERTs (kept as
-- separate statements deliberately -- each vector literal is ~9KB of text,
-- and doing them one at a time is far less error-prone to transmit than one
-- combined multi-KB blob).
--
-- Zero RLS policies, same "unreachable from client entirely" pattern as
-- admin_users/app_secrets: this is classifier config, not user data, and only
-- the chat edge function (service role) ever needs to read it.
CREATE TABLE public.model_router_centroids (
  tier       text PRIMARY KEY CHECK (tier IN ('light', 'medium', 'heavy')),
  embedding  vector(1024) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.model_router_centroids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.model_router_centroids FROM anon, authenticated;

-- classify_router_tier: returns the tier (light/medium/heavy) whose centroid
-- is nearest the given embedding by cosine similarity. SECURITY DEFINER so it
-- can read model_router_centroids despite that table having zero RLS
-- policies open to anyone; only ever returns one short text value, never raw
-- centroid data, so this is safe to expose the same way get_credit_balance's
-- aggregate-only SECURITY DEFINER is.
CREATE OR REPLACE FUNCTION public.classify_router_tier(p_embedding vector(1024))
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT tier
  FROM public.model_router_centroids
  ORDER BY embedding <=> p_embedding
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.classify_router_tier(vector) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.classify_router_tier(vector) TO service_role;
