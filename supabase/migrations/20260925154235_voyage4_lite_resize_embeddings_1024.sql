-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.


-- Drop HNSW indexes (required before column type change)
DROP INDEX IF EXISTS document_chunks_hnsw_idx;
DROP INDEX IF EXISTS memory_embeddings_hnsw_idx;

-- Null out any existing 512-dim embeddings (incompatible with 1024-dim)
UPDATE document_chunks  SET embedding = NULL WHERE embedding IS NOT NULL;
UPDATE memory_embeddings SET embedding = NULL WHERE embedding IS NOT NULL;

-- Drop and re-add as vector(1024) — cleanest cross-dimension resize
ALTER TABLE document_chunks   DROP COLUMN embedding;
ALTER TABLE document_chunks   ADD  COLUMN embedding vector(1024);

ALTER TABLE memory_embeddings DROP COLUMN embedding;
ALTER TABLE memory_embeddings ADD  COLUMN embedding vector(1024);

-- Rebuild HNSW indexes for cosine similarity
CREATE INDEX document_chunks_hnsw_idx   ON document_chunks   USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memory_embeddings_hnsw_idx ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
