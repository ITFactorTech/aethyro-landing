-- Backfilled from Supabase's live migration-history table on 2026-10-09
-- during migration-history reconciliation (see CLAUDE.md's 'Pending'
-- entry and recent-work-log). This is the real SQL this version
-- actually ran against production; it was previously untracked in
-- this repo. Added so supabase db push recognizes this version and
-- never tries to re-run it.

-- ============================================================
-- Sovereign Economy + Local AI Mesh Knowledge Layer
-- pgvector hybrid KB alongside ChromaDB
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector

CREATE EXTENSION IF NOT EXISTS pg_trgm

-- trigram search for fuzzy text matching
CREATE EXTENSION IF NOT EXISTS btree_gin

-- GIN indexes for JSONB

-- ============================================================
-- KNOWLEDGE BASE  (mirrors + extends ChromaDB knowledge_base)
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_base (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    embedding   vector(768),           -- nomic-embed-text dimension
    source      TEXT DEFAULT '',
    tag         TEXT DEFAULT '',
    url         TEXT DEFAULT '',
    title       TEXT DEFAULT '',
    file        TEXT DEFAULT '',
    quality     REAL DEFAULT 1.0,
    char_count  INT  GENERATED ALWAYS AS (length(text)) STORED,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
)

-- HNSW index — cosine distance matches ChromaDB's hnsw:space=cosine
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_idx
    ON knowledge_base
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)

-- Full-text + trigram for hybrid search
CREATE INDEX IF NOT EXISTS knowledge_base_text_gin
    ON knowledge_base
    USING gin (to_tsvector('english', text))

CREATE INDEX IF NOT EXISTS knowledge_base_source_idx ON knowledge_base (source)

CREATE INDEX IF NOT EXISTS knowledge_base_tag_idx    ON knowledge_base (tag)

CREATE INDEX IF NOT EXISTS knowledge_base_quality_idx ON knowledge_base (quality DESC)

-- ============================================================
-- AGENT MEMORIES  (mirrors ChromaDB agent_memories collection)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_memories (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    embedding     vector(768),
    role          TEXT DEFAULT 'general',
    quality_score REAL DEFAULT 1.0,
    task_category TEXT DEFAULT '',
    agent_name    TEXT DEFAULT '',
    model_used    TEXT DEFAULT '',
    created_at    TIMESTAMPTZ DEFAULT now()
)

CREATE INDEX IF NOT EXISTS agent_memories_embedding_idx
    ON agent_memories
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)

CREATE INDEX IF NOT EXISTS agent_memories_role_idx    ON agent_memories (role)

CREATE INDEX IF NOT EXISTS agent_memories_quality_idx ON agent_memories (quality_score DESC)

CREATE INDEX IF NOT EXISTS agent_memories_category_idx ON agent_memories (task_category)

-- ============================================================
-- ECONOMY TICKS  (Sovereign Economy tick snapshots)
-- ============================================================
CREATE TABLE IF NOT EXISTS economy_ticks (
    tick            INT PRIMARY KEY,
    ts              TIMESTAMPTZ DEFAULT now(),
    active_agents   INT DEFAULT 0,
    total_wealth    REAL DEFAULT 0,
    gini_coeff      REAL DEFAULT 0,
    avg_wealth      REAL DEFAULT 0,
    median_wealth   REAL DEFAULT 0,
    treasury        REAL DEFAULT 0,
    inflation_rate  REAL DEFAULT 0,
    gdp             REAL DEFAULT 0,
    tasks_posted    INT DEFAULT 0,
    tasks_completed INT DEFAULT 0,
    tasks_failed    INT DEFAULT 0,
    births          INT DEFAULT 0,
    deaths          INT DEFAULT 0,
    loans_issued    INT DEFAULT 0,
    bonds_issued    INT DEFAULT 0,
    extra           JSONB DEFAULT '{}'
)

CREATE INDEX IF NOT EXISTS economy_ticks_ts_idx ON economy_ticks (ts DESC)

-- ============================================================
-- AGENT SNAPSHOTS  (per-tick agent stats for trend analysis)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_snapshots (
    id           BIGSERIAL PRIMARY KEY,
    tick         INT NOT NULL REFERENCES economy_ticks(tick) ON DELETE CASCADE,
    agent_id     INT NOT NULL,
    agent_name   TEXT NOT NULL,
    role         TEXT DEFAULT '',
    skills       TEXT DEFAULT '',
    wealth       REAL DEFAULT 0,
    tasks_done   INT DEFAULT 0,
    reputation   REAL DEFAULT 0,
    fitness      REAL DEFAULT 0,
    status       TEXT DEFAULT 'ACTIVE',
    created_at   TIMESTAMPTZ DEFAULT now()
)

CREATE INDEX IF NOT EXISTS agent_snapshots_tick_idx      ON agent_snapshots (tick)

CREATE INDEX IF NOT EXISTS agent_snapshots_agent_id_idx  ON agent_snapshots (agent_id)

CREATE INDEX IF NOT EXISTS agent_snapshots_wealth_idx    ON agent_snapshots (wealth DESC)

-- ============================================================
-- SEMANTIC SEARCH FUNCTION  (cosine similarity, top-k)
-- ============================================================
CREATE OR REPLACE FUNCTION search_knowledge(
    query_embedding vector(768),
    match_count     INT     DEFAULT 5,
    filter_tag      TEXT    DEFAULT NULL,
    filter_source   TEXT    DEFAULT NULL,
    min_quality     REAL    DEFAULT 0.0
)
RETURNS TABLE (
    id          TEXT,
    text        TEXT,
    source      TEXT,
    tag         TEXT,
    title       TEXT,
    url         TEXT,
    quality     REAL,
    similarity  REAL
)
LANGUAGE SQL STABLE
AS $$
    SELECT
        kb.id,
        kb.text,
        kb.source,
        kb.tag,
        kb.title,
        kb.url,
        kb.quality,
        1 - (kb.embedding <=> query_embedding) AS similarity
    FROM knowledge_base kb
    WHERE
        (filter_tag    IS NULL OR kb.tag    = filter_tag)
        AND (filter_source IS NULL OR kb.source = filter_source)
        AND kb.quality >= min_quality
        AND kb.embedding IS NOT NULL
    ORDER BY kb.embedding <=> query_embedding
    LIMIT match_count;
$$

-- ============================================================
-- HYBRID SEARCH FUNCTION  (vector + full-text combined)
-- ============================================================
CREATE OR REPLACE FUNCTION hybrid_search_knowledge(
    query_text      TEXT,
    query_embedding vector(768),
    match_count     INT  DEFAULT 5,
    vector_weight   REAL DEFAULT 0.7,
    text_weight     REAL DEFAULT 0.3
)
RETURNS TABLE (
    id          TEXT,
    text        TEXT,
    source      TEXT,
    tag         TEXT,
    title       TEXT,
    url         TEXT,
    quality     REAL,
    similarity  REAL
)
LANGUAGE SQL STABLE
AS $$
    WITH vector_scores AS (
        SELECT
            kb.id,
            1 - (kb.embedding <=> query_embedding) AS vscore
        FROM knowledge_base kb
        WHERE kb.embedding IS NOT NULL
        ORDER BY kb.embedding <=> query_embedding
        LIMIT match_count * 3
    ),
    text_scores AS (
        SELECT
            kb.id,
            ts_rank(to_tsvector('english', kb.text),
                    plainto_tsquery('english', query_text)) AS tscore
        FROM knowledge_base kb
        WHERE to_tsvector('english', kb.text) @@ plainto_tsquery('english', query_text)
        LIMIT match_count * 3
    ),
    combined AS (
        SELECT
            COALESCE(v.id, t.id) AS id,
            COALESCE(v.vscore, 0) * vector_weight
            + COALESCE(t.tscore, 0) * text_weight AS combined_score
        FROM vector_scores v
        FULL OUTER JOIN text_scores t ON v.id = t.id
    )
    SELECT
        kb.id,
        kb.text,
        kb.source,
        kb.tag,
        kb.title,
        kb.url,
        kb.quality,
        c.combined_score::REAL AS similarity
    FROM combined c
    JOIN knowledge_base kb ON kb.id = c.id
    ORDER BY c.combined_score DESC
    LIMIT match_count;
$$

-- ============================================================
-- ECONOMY SUMMARY VIEW  (latest stats at a glance)
-- ============================================================
CREATE OR REPLACE VIEW economy_latest AS
    SELECT * FROM economy_ticks ORDER BY tick DESC LIMIT 1

CREATE OR REPLACE VIEW economy_trend_7d AS
    SELECT
        tick,
        ts,
        active_agents,
        total_wealth,
        gini_coeff,
        gdp,
        tasks_completed,
        births,
        deaths
    FROM economy_ticks
    ORDER BY tick DESC
    LIMIT 500

-- ============================================================
-- TRIGGER: auto-update updated_at on knowledge_base
-- ============================================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$

DROP TRIGGER IF EXISTS knowledge_base_updated_at ON knowledge_base

CREATE TRIGGER knowledge_base_updated_at
    BEFORE UPDATE ON knowledge_base
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at()

-- Done
COMMENT ON TABLE knowledge_base IS 'pgvector mirror of ChromaDB knowledge_base (10,945 docs) + additional ingested content. 768-dim nomic-embed-text embeddings.'

COMMENT ON TABLE agent_memories IS 'pgvector mirror of ChromaDB agent_memories (per-task memory with quality scoring).'

COMMENT ON TABLE economy_ticks IS 'Sovereign Economy tick snapshots — one row per completed tick cycle.'

COMMENT ON TABLE agent_snapshots IS 'Per-agent wealth/skill/reputation snapshots per tick for trend analysis.'