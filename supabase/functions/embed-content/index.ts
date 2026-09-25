// embed-content v2 — voyage-4-lite (1024-dim), chunking + memory storage
// Stores memory turn embeddings and document-chunk embeddings in pgvector.
// Called fire-and-forget from chat (memory) and from the frontend (doc upload).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const VOYAGE_API_KEY    = Deno.env.get("VOYAGE_API_KEY");

const VOYAGE_MODEL = "voyage-4-lite"; // 1024-dim embeddings
const CHUNK_SIZE   = 800;             // characters per chunk
const CHUNK_OVERLAP = 100;

// ── Voyage AI embed ───────────────────────────────────────────────────────────

async function embed(texts: string[]): Promise<number[][] | null> {
  if (!VOYAGE_API_KEY || !texts.length) return null;
  try {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: texts }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.data?.map((d: any) => d.embedding) ?? null;
  } catch {
    return null;
  }
}

// ── Text chunker ──────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter(c => c.length > 20);
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  // Auth — accept both user JWT and service-role key
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/, "");
  if (!jwt)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });

  let userId: string;
  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Try service-role path first (called internally with user_id in body)
  if (jwt === SERVICE_ROLE_KEY) {
    const body = await req.json();
    userId = body.user_id;
    if (!userId)
      return new Response(JSON.stringify({ error: "user_id required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    return handleRequest(body, userId, supaAdmin);
  }

  // User JWT path
  const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error } = await supaUser.auth.getUser();
  if (error || !user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  return handleRequest(body, user.id, supaAdmin);
});

async function handleRequest(
  body: any,
  userId: string,
  supaAdmin: ReturnType<typeof createClient>,
): Promise<Response> {
  const ok = (data: any) =>
    new Response(JSON.stringify(data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const type: string = body.type; // 'memory' | 'document'

  // ── Memory: embed a conversation turn ─────────────────────────────────────
  if (type === "memory") {
    const { role, content, conversation_id } = body;
    if (!role || !content) return err("role and content required");

    const vecs = await embed([content]);
    const embedding = vecs?.[0] ?? null;

    const { error } = await supaAdmin.from("memory_embeddings").insert({
      user_id: userId,
      conversation_id: conversation_id || null,
      role,
      content: content.slice(0, 4000),
      embedding,
    });
    if (error) return err(error.message, 500);
    return ok({ stored: true, has_embedding: !!embedding });
  }

  // ── Document: chunk + embed + store ──────────────────────────────────────
  if (type === "document") {
    const { name, content, file_type } = body;
    if (!name || !content) return err("name and content required");

    // Create document record
    const { data: doc, error: docErr } = await supaAdmin
      .from("user_documents")
      .insert({
        user_id: userId,
        name,
        file_type: file_type || "text/plain",
        size_bytes: content.length,
      })
      .select("id")
      .single();
    if (docErr) return err(docErr.message, 500);

    const chunks = chunkText(content);
    const embeddings = await embed(chunks);

    const rows = chunks.map((chunk, i) => ({
      document_id: doc.id,
      user_id: userId,
      chunk_index: i,
      content: chunk,
      embedding: embeddings?.[i] ?? null,
    }));

    const { error: chunkErr } = await supaAdmin
      .from("document_chunks")
      .insert(rows);
    if (chunkErr) return err(chunkErr.message, 500);

    // Update chunk count on document
    await supaAdmin
      .from("user_documents")
      .update({ chunk_count: chunks.length })
      .eq("id", doc.id);

    return ok({ document_id: doc.id, chunks: chunks.length, has_embeddings: !!embeddings });
  }

  // ── Semantic search: retrieve top-k similar chunks ────────────────────────
  if (type === "search") {
    const { query, source, limit: k = 5 } = body;
    if (!query) return err("query required");

    const vecs = await embed([query]);
    if (!vecs) return ok({ results: [] });

    let data: any, error: any;
    if (source === "documents") {
      ({ data, error } = await supaAdmin.rpc("match_document_chunks", {
        p_user_id: userId,
        p_embedding: vecs[0],
        p_limit: Math.min(k, 10),
      }));
    } else {
      ({ data, error } = await supaAdmin.rpc("match_memory_embeddings", {
        p_user_id: userId,
        p_embedding: vecs[0],
        p_limit: Math.min(k, 10),
      }));
    }
    if (error) return ok({ results: [] });
    return ok({ results: data || [] });
  }

  return err("type must be 'memory', 'document', or 'search'");
}
