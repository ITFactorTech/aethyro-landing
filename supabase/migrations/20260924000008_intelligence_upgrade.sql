-- Intelligence Upgrade: pgvector semantic memory, RAG documents,
-- long-horizon agent tasks, scheduled routines, live integrations

-- ── 1. pgvector extension ─────────────────────────────────────────────────────
create extension if not exists vector with schema extensions;

-- ── 2. Semantic memory embeddings (per conversation turn) ─────────────────────
create table if not exists memory_embeddings (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  conversation_id text,
  role          text        not null check (role in ('user', 'assistant')),
  content       text        not null,
  embedding     vector(512),                          -- voyage-3-lite dims
  created_at    timestamptz default now()
);

create index if not exists memory_embeddings_user_idx
  on memory_embeddings (user_id);
create index if not exists memory_embeddings_hnsw_idx
  on memory_embeddings using hnsw (embedding vector_cosine_ops);

alter table memory_embeddings enable row level security;
create policy "memory_own" on memory_embeddings
  for all using (auth.uid() = user_id);

-- ── 3. User knowledge-base documents ─────────────────────────────────────────
create table if not exists user_documents (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  name          text        not null,
  file_type     text,
  size_bytes    int,
  chunk_count   int         default 0,
  created_at    timestamptz default now()
);

alter table user_documents enable row level security;
create policy "docs_own" on user_documents
  for all using (auth.uid() = user_id);

-- ── 4. Document chunks for RAG ────────────────────────────────────────────────
create table if not exists document_chunks (
  id            uuid        default gen_random_uuid() primary key,
  document_id   uuid        references user_documents(id) on delete cascade not null,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  chunk_index   int         not null,
  content       text        not null,
  embedding     vector(512),
  created_at    timestamptz default now()
);

create index if not exists document_chunks_user_idx
  on document_chunks (user_id);
create index if not exists document_chunks_hnsw_idx
  on document_chunks using hnsw (embedding vector_cosine_ops);

alter table document_chunks enable row level security;
create policy "chunks_own" on document_chunks
  for all using (auth.uid() = user_id);

-- ── 5. Long-horizon agent tasks ───────────────────────────────────────────────
create table if not exists agent_tasks (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  goal          text        not null,
  plan          jsonb,
  status        text        default 'pending'
                            check (status in ('pending','running','completed','failed')),
  result        text,
  credits_used  int         default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table agent_tasks enable row level security;
create policy "tasks_own" on agent_tasks
  for all using (auth.uid() = user_id);

-- ── 6. Agent task steps ───────────────────────────────────────────────────────
create table if not exists agent_task_steps (
  id            uuid        default gen_random_uuid() primary key,
  task_id       uuid        references agent_tasks(id) on delete cascade not null,
  step_index    int         not null,
  description   text        not null,
  status        text        default 'pending'
                            check (status in ('pending','running','completed','failed','skipped')),
  tool_calls    jsonb,
  result        text,
  created_at    timestamptz default now()
);

alter table agent_task_steps enable row level security;
create policy "steps_own" on agent_task_steps
  for all using (
    exists (
      select 1 from agent_tasks
      where id = agent_task_steps.task_id
        and user_id = auth.uid()
    )
  );

-- ── 7. Scheduled routines ─────────────────────────────────────────────────────
create table if not exists user_routines (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  name          text        not null,
  prompt        text        not null,
  schedule      text        not null,  -- cron expression e.g. '0 9 * * 1-5'
  enabled       boolean     default true,
  model         text        default 'haiku',
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  last_result   text,
  created_at    timestamptz default now()
);

alter table user_routines enable row level security;
create policy "routines_own" on user_routines
  for all using (auth.uid() = user_id);

-- ── 8. Live integrations (stored tokens) ─────────────────────────────────────
create table if not exists user_integrations (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  provider      text        not null
                            check (provider in ('github','notion','google')),
  access_token  text,       -- stored as-is (PAT or API key); encrypt at app layer
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  metadata      jsonb,
  created_at    timestamptz default now(),
  unique (user_id, provider)
);

alter table user_integrations enable row level security;
create policy "integrations_own" on user_integrations
  for all using (auth.uid() = user_id);

-- ── 9. Routine execution helper: compute next_run_at from cron expression ─────
-- (Simple: pg_cron handles scheduling; this stores the pre-computed next time
--  set by the run-routines edge function after each execution.)

-- ── 10. match_embeddings RPC (used by embed-content search + chat retrieval) ──
-- Returns top-k rows from memory_embeddings or document_chunks by cosine similarity.
create or replace function match_memory_embeddings(
  p_user_id   uuid,
  p_embedding vector(512),
  p_limit     int default 5
)
returns table (
  id          uuid,
  role        text,
  content     text,
  similarity  float
)
language sql stable security invoker
as $$
  select id, role, content,
         1 - (embedding <=> p_embedding) as similarity
  from memory_embeddings
  where user_id = p_user_id
    and embedding is not null
  order by embedding <=> p_embedding
  limit p_limit;
$$;

create or replace function match_document_chunks(
  p_user_id   uuid,
  p_embedding vector(512),
  p_limit     int default 3
)
returns table (
  id          uuid,
  document_id uuid,
  content     text,
  similarity  float
)
language sql stable security invoker
as $$
  select dc.id, dc.document_id, dc.content,
         1 - (dc.embedding <=> p_embedding) as similarity
  from document_chunks dc
  where dc.user_id = p_user_id
    and dc.embedding is not null
  order by dc.embedding <=> p_embedding
  limit p_limit;
$$;

-- ── 11. pg_cron: fire run-routines every 15 minutes ──────────────────────────
-- Requires pg_net to call the edge function from the database.
-- If pg_net is not available this schedule is a no-op.
-- pg_cron is managed in Supabase dashboard; schedule run-routines manually there
-- if pg_net is available, this fires every 15 minutes automatically
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- unschedule any previous version first
    perform cron.unschedule('run-routines-15min');
  end if;
exception when others then null;
end $$;

do $$
declare
  v_url text;
begin
  if exists (
    select 1 from pg_extension where extname = 'pg_cron'
  ) and exists (
    select 1 from pg_extension where extname = 'pg_net'
  ) then
    -- Use vault or app settings for the URL/key; fall back if not configured
    v_url := coalesce(
      current_setting('app.supabase_url', true),
      ''
    );
    if v_url <> '' then
      perform cron.schedule(
        'run-routines-15min',
        '*/15 * * * *',
        format(
          $cron$select net.http_post(url := %L || '/functions/v1/run-routines',
            headers := '{"Content-Type":"application/json","Authorization":"Bearer placeholder"}'::jsonb,
            body := '{}'::jsonb);$cron$,
          v_url
        )
      );
    end if;
  end if;
exception when others then null;
end $$;
