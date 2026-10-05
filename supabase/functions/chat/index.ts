// chat v46 — adds signed generation receipts: finalize() now calls the new
// create_generation_receipt RPC right after billing and includes the
// result (payload + HMAC-SHA256 signature) in USAGE_MARK as `receipt`, so
// the client gets a tamper-evident record of model/tokens/cost/context for
// every reply in the same response, no follow-up round trip. Counterpart
// to the existing deletion receipts; see that migration's own comment and
// 20261006000000_generation_receipts.sql for why the RPC only trusts this
// function's own service-role caller.
// chat v45 — found live 2026-10-05: a user whose balance went 47 -> -34
// credits in one Opus reply never got any notification, warning or
// depleted, since the low-credit email only fires for newBal in 1-30 and
// there was no branch at all for newBal <= 0 (only the reactive client-side
// "No credits left" banner, seen only if the user reopens the tab). Added an
// else-if branch below that fires send-low-credit-email with depleted:true
// when newBal <= 0, gated by its own new credits_depleted_warned_at cooldown
// column so it never competes with the existing warning email's cooldown.
// chat v37 — Phase 3: model:"auto" now resolves via a real nearest-centroid
// embedding classifier (classifyModelFromEmbedding -> classify_router_tier()
// DB function, pgvector) instead of routeAutoModel()'s keyword/length
// heuristic alone, which is now only the fallback when no embedding is
// available or the RPC fails. Centroids live in public.model_router_centroids,
// not as source literals -- see classifyModelFromEmbedding's own comment.
// chat v36 — chat_usage credit_ledger inserts now stamp team_id (from the
// acting user's profiles.team_id at insert time) so usage by any team
// member draws from the shared pool get_credit_balance() now understands.
// v35 — merges two independently-shipped v34 changes:
// (1) the low-credit path now also fires auto-topup-charge (fire-and-forget,
// alongside the existing send-low-credit-email) when the user has
// auto_topup_enabled — an off-session Stripe charge for their configured
// pack instead of just a warning email. Independent cooldown from the
// email's 24h one; auto-topup-charge enforces its own.
// (2) adds model:"auto" support. The client can now send model:"auto"
// instead of a fixed haiku/sonnet/opus key; routeAutoModel() picks a real
// MODEL_MAP key with a cheap rule-based heuristic (message length, a few
// keyword signals, presence of attachments) run before the Anthropic call —
// no second LLM call, no added latency. The resolved model is billed and
// reported exactly like an explicit choice; USAGE_MARK's cost object also
// carries requestedModel so the client can show "Auto → Opus" instead of
// just "Opus" when routing picked it.
// v33 — chat_usage credit_ledger inserts now carry metadata: {model,
// input_tokens, output_tokens}, so a per-model cost-mix breakdown (added to
// dashboard.html this session) has real data to chart going forward. Rows
// from before this deploy have metadata: null and are excluded from that
// chart rather than counted as "unknown".
// v32 — fixes every internal supaAdmin.functions.invoke() call (embed-content
// x2, send-low-credit-email): supabase-js does NOT auto-send an Authorization
// header derived from the client's key when that key is one of Supabase's
// newer sb_secret_... format service-role keys (confirmed live: default invoke()
// got a 401 from embed-content's own auth check; passing the header explicitly
// returned 200). send-low-credit-email never worked at all — it doesn't check
// Authorization, it checks a custom X-Internal-Key header nothing was setting.
// Every internal function call here now passes its required header explicitly.
// Also carries v31's EdgeRuntime.waitUntil() fix (the fire-and-forget memory
// block could get killed mid-flight when the isolate froze right after
// controller.close()), v30's extended-thinking fix (claude-opus-5-5/
// claude-sonnet-5 reject {type:"enabled",budget_tokens}; switched to
// {type:"adaptive",display:"summarized"}), and v29's per-message cost
// breakdown (credits/tokens/rates) in USAGE_MARK.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.24.3?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TAVILY_API_KEY    = Deno.env.get("TAVILY_API_KEY");
const VOYAGE_API_KEY    = Deno.env.get("VOYAGE_API_KEY");

const TITLE_MODEL         = "claude-haiku-4-5-20251001";
const VOYAGE_MODEL        = "voyage-4-lite";
const MAX_TOKENS          = 4096;
const TITLE_TOKENS        = 80;
const LOW_CREDIT_THRESHOLD = 30;
const MAX_ATTACHMENTS     = 3;
const MAX_TOOL_ROUNDS     = 4;
const CHAT_RATE_LIMIT_PER_MINUTE = 20;

const MODEL_MAP: Record<string, string> = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus:   "claude-opus-5-5",
};
const CREDIT_RATES: Record<string, { input: number; output: number }> = {
  haiku:  { input: 0.08,  output: 0.40  },
  sonnet: { input: 0.30,  output: 1.50  },
  opus:   { input: 1.50,  output: 7.50  },
};

// Cheap, rule-based router for model:"auto" — no LLM call, runs synchronously
// before the real request. Errs toward Opus whenever a signal is ambiguous;
// only routes down to Haiku for clearly trivial messages, and never routes
// an attachment (document/image) below Sonnet.
const AUTO_HEAVY_SIGNALS = [
  "audit", "security", "vulnerab", "architecture", "refactor", "debug",
  "prove", "optimi", "algorithm", "strategy", "analyz", "analysis",
  "contract", "legal", "compliance", "research", "comprehensive",
  "in-depth", "in depth", "detailed plan", "step by step", "step-by-step",
  "compare", "pros and cons", "root cause", "design a", "write a full",
];
const AUTO_LIGHT_RE = /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|sure|yes|no|got it|sounds good|np|k)\b[.!?]*$/i;

function routeAutoModel(message: string, attachments: Attachment[]): "haiku" | "sonnet" | "opus" {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const len = trimmed.length;

  if (attachments.length > 0) {
    // Documents/images need real reading comprehension; never trivialize these.
    return len > 400 || AUTO_HEAVY_SIGNALS.some(s => lower.includes(s)) ? "opus" : "sonnet";
  }

  const isHeavy = len > 500 || AUTO_HEAVY_SIGNALS.some(s => lower.includes(s));
  if (isHeavy) return "opus";

  const isLight = len > 0 && len <= 40 && (AUTO_LIGHT_RE.test(trimmed) || !/[?]/.test(trimmed) && len <= 15);
  if (isLight) return "haiku";

  return "sonnet";
}

// Phase 3: smarter auto-model router. classify_router_tier() is a DB-side
// SQL function (public.model_router_centroids + pgvector's <=> operator)
// that returns the nearest of 3 reference centroids (light/medium/heavy) by
// cosine distance -- same pattern match_memory_embeddings/match_document_chunks
// already use for semantic retrieval, just applied to routing instead.
// Centroids are unit-normalized mean voyage-4-lite embeddings over ~25
// curated example prompts per tier; leave-one-out cross-validation on that
// set was 94.7% accurate (71/75), with every miss an adjacent-tier confusion
// (light<->medium), never a light/heavy or medium/heavy mix-up. Deliberately
// NOT inlined as source-code literals (an earlier attempt at that briefly
// broke this function entirely via a botched large deploy -- see recent-
// work-log) -- keeping this file small and pushing the big data into the DB
// is both safer to ship and consistent with how this codebase already does
// vector similarity everywhere else.
async function classifyModelFromEmbedding(
  supaAdmin: ReturnType<typeof createClient>,
  embedding: number[] | null,
  message: string,
  attachments: Attachment[],
): Promise<"haiku" | "sonnet" | "opus"> {
  let tier: "light" | "medium" | "heavy" | null = null;
  if (embedding) {
    const { data, error } = await supaAdmin.rpc("classify_router_tier", { p_embedding: embedding });
    if (!error && (data === "light" || data === "medium" || data === "heavy")) tier = data;
  }
  // Falls back to the keyword/length heuristic above whenever no embedding
  // is available (Voyage down, no API key, timeout) or the RPC itself
  // failed for any reason -- must never be a single point of failure.
  if (!tier) return routeAutoModel(message, attachments);

  // Safety nets, same asymmetric bias as the heuristic ("err toward Opus
  // whenever ambiguous") -- both can only push the tier UP, never down.
  const lower = message.trim().toLowerCase();
  if (AUTO_HEAVY_SIGNALS.some(s => lower.includes(s))) tier = "heavy";
  if (attachments.length > 0 && tier === "light") tier = "medium";

  return tier === "light" ? "haiku" : tier === "heavy" ? "opus" : "sonnet";
}

const TOOL_MARK  = "\x01";
const USAGE_MARK = "\x00";
const THINK_MARK = "\x02";
const MAX_TOKENS_THINKING = 8192;

// ── Voyage AI embed (single text) ─────────────────────────────────────────────

async function embedText(text: string): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) return null;
  try {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: [text] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// ── Web search ────────────────────────────────────────────────────────────────

async function executeWebSearch(query: string): Promise<string> {
  if (!TAVILY_API_KEY) return "Search unavailable.";
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: 5,
        include_answer: true,
        search_depth: "basic",
      }),
      signal: AbortSignal.timeout(9000),
    });
    if (!resp.ok) return `Search failed (${resp.status}).`;
    const data = await resp.json();
    let out = "";
    if (data.answer) out += `Summary: ${data.answer}\n\n`;
    if (data.results?.length) {
      out += "Sources:\n" + data.results.slice(0, 5).map(
        (r: any, i: number) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${(r.content || "").slice(0, 400)}`
      ).join("\n\n");
    }
    return out.slice(0, 8000) || "No results found.";
  } catch {
    return "Search timed out or failed.";
  }
}

// ── GitHub proxy ──────────────────────────────────────────────────────────────

async function githubRequest(token: string, path: string): Promise<any> {
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`GitHub ${resp.status}`);
  return resp.json();
}

// ── Notion proxy ──────────────────────────────────────────────────────────────

async function notionRequest(token: string, path: string, method = "GET", body?: any): Promise<any> {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Notion ${resp.status}`);
  return resp.json();
}

function extractNotionText(blocks: any[]): string {
  return blocks.map(b => {
    const rt = b[b.type]?.rich_text;
    return rt ? rt.map((t: any) => t.plain_text || "").join("") : "";
  }).filter(Boolean).join("\n").slice(0, 6000);
}

// ── Memory helpers ────────────────────────────────────────────────────────────

type UserMemory = {
  name?: string;
  occupation?: string;
  company?: string;
  location?: string;
  preferences?: string[];
  projects?: string[];
  facts?: string[];
};

function formatMemory(m: UserMemory): string {
  const lines: string[] = [];
  if (m.name) lines.push(`Name: ${m.name}`);
  if (m.occupation) lines.push(`Occupation: ${m.occupation}`);
  if (m.company) lines.push(`Company: ${m.company}`);
  if (m.location) lines.push(`Location: ${m.location}`);
  if (m.preferences?.length) lines.push(`Preferences: ${m.preferences.join(", ")}`);
  if (m.projects?.length) lines.push(`Projects: ${m.projects.join(", ")}`);
  if (m.facts?.length) lines.push(`Facts: ${m.facts.join("; ")}`);
  return lines.join("\n");
}

function mergeMemory(existing: UserMemory, incoming: Partial<UserMemory>): UserMemory {
  const merged: any = { ...existing };
  for (const key of Object.keys(incoming) as (keyof UserMemory)[]) {
    const val = incoming[key];
    if (val === null || val === undefined || val === "") continue;
    if (Array.isArray(val) && Array.isArray(merged[key])) {
      merged[key] = [...new Set([...(merged[key] as string[]), ...(val as string[])])].slice(0, 12);
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

// ── Attachment helpers ────────────────────────────────────────────────────────

type Attachment = {
  type: "text" | "image";
  filename: string;
  content?: string;
  data?: string;
  mediaType?: string;
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function buildUserContent(message: string, attachments: Attachment[]): string | ContentBlock[] {
  if (!attachments.length) return message;
  const blocks: ContentBlock[] = [];
  for (const att of attachments.slice(0, MAX_ATTACHMENTS)) {
    if (att.type === "image" && att.data && att.mediaType) {
      blocks.push({ type: "image", source: { type: "base64", media_type: att.mediaType as any, data: att.data } });
    } else if (att.type === "text" && att.content != null) {
      blocks.push({ type: "text", text: `[Attached file: ${att.filename}]\n---\n${att.content.slice(0, 30000)}\n---` });
    }
  }
  blocks.push({ type: "text", text: message });
  return blocks;
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
  if (!jwt)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await supaUser.auth.getUser();
  if (userErr || !user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Per-user rate limit: a fixed 1-minute window, keyed by user id, shared
  // RPC with api-chat (see increment_rate_limit's own migration). Checked
  // before body parsing so a request that's merely too frequent never pays
  // JSON-parse/credit-check cost. A failed RPC call fails open (logs, lets
  // the request through) rather than blocking real users on an infra hiccup
  // -- same posture this function already takes with best-effort background
  // work elsewhere.
  {
    const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const { data: rlCount, error: rlErr } = await supaAdmin.rpc("increment_rate_limit", {
      p_key_type: "chat_user", p_key_value: user.id, p_window_start: windowStart,
    });
    if (rlErr) {
      console.error("chat: rate limit check failed", rlErr.message);
    } else if (typeof rlCount === "number" && rlCount > CHAT_RATE_LIMIT_PER_MINUTE) {
      return new Response(JSON.stringify({ error: "Too many requests, please slow down" }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json", "Retry-After": "60" },
      });
    }
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const message: string   = (body.message || "").trim();
  const historyRaw        = Array.isArray(body.history) ? body.history : [];
  const attachments       = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS) : [];
  const conversationId    = body.conversation_id || null;
  const requestedModel    = body.model === "auto" ? "auto" : (["haiku", "sonnet", "opus"].includes(body.model) ? body.model : "haiku");

  if (!message && !attachments.length)
    return new Response(JSON.stringify({ error: "Empty message" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });

  // Credit check
  const { data: balance } = await supaAdmin.rpc("get_credit_balance", { p_user_id: user.id });
  if (typeof balance === "number" && balance <= 0)
    return new Response(JSON.stringify({ error: "No credits", balance: 0 }), {
      status: 402, headers: { ...CORS, "Content-Type": "application/json" },
    });

  // ── Load profile, memory, integrations in parallel ────────────────────────
  // embedText(message) here does double duty: it's already needed below for
  // semantic memory/document retrieval, and reusing it for "auto" model
  // classification (instead of a second Voyage call) costs zero extra
  // latency -- the classifier just runs after this Promise.all resolves.
  const [profileRes, integrationsRes, queryEmbedding] = await Promise.all([
    supaAdmin.from("profiles").select("workspace_context, memory, team_id").eq("id", user.id).single(),
    supaAdmin.from("user_integrations").select("provider, access_token, metadata").eq("user_id", user.id),
    embedText(message),
  ]);

  const modelKey = requestedModel === "auto" ? await classifyModelFromEmbedding(supaAdmin, queryEmbedding, message, attachments) : requestedModel;
  const MODEL    = MODEL_MAP[modelKey];
  const rates    = CREDIT_RATES[modelKey];

  let existingMemory: UserMemory = {};
  let systemPrompt = "You are Aethyro, a highly capable AI assistant.";
  // Counts of retrieved context actually used, surfaced later in this
  // message's signed generation receipt (see finalize()) -- not just
  // whether retrieval ran, but how many hits cleared the similarity bar.
  let memoryContextCount = 0;
  let documentContextCount = 0;

  if (TAVILY_API_KEY) {
    systemPrompt += " You have a web_search tool — use it proactively for current events, news, prices, scores, release dates, or anything time-sensitive. Answer from knowledge for timeless facts.";
  }

  // Flat JSONB memory (structured facts)
  existingMemory = (profileRes.data?.memory && typeof profileRes.data.memory === "object")
    ? profileRes.data.memory as UserMemory
    : {};
  const memStr = formatMemory(existingMemory);
  if (memStr) systemPrompt += `\n\n--- What I know about you ---\n${memStr}`;

  // Workspace context
  if (profileRes.data?.workspace_context) {
    systemPrompt += `\n\n--- User context ---\n${profileRes.data.workspace_context}`;
  }

  // ── Semantic memory retrieval (vector similarity) ─────────────────────────
  if (queryEmbedding && VOYAGE_API_KEY) {
    const { data: memHits } = await supaAdmin.rpc("match_memory_embeddings", {
      p_user_id: user.id,
      p_embedding: queryEmbedding,
      p_limit: 5,
    });
    if (memHits?.length) {
      const relevant = memHits.filter((h: any) => h.similarity > 0.65).slice(0, 4);
      if (relevant.length) {
        memoryContextCount = relevant.length;
        systemPrompt += "\n\n--- Relevant past conversations ---";
        for (const h of relevant) {
          systemPrompt += `\n[${h.role}]: ${h.content.slice(0, 400)}`;
        }
      }
    }

    // ── Document RAG retrieval ────────────────────────────────────────────────
    const { data: docHits } = await supaAdmin.rpc("match_document_chunks", {
      p_user_id: user.id,
      p_embedding: queryEmbedding,
      p_limit: 3,
    });
    if (docHits?.length) {
      const relevant = docHits.filter((h: any) => h.similarity > 0.60).slice(0, 3);
      if (relevant.length) {
        documentContextCount = relevant.length;
        systemPrompt += "\n\n--- From your knowledge base ---";
        for (const h of relevant) {
          systemPrompt += `\n${h.content.slice(0, 600)}`;
        }
      }
    }
  }

  // ── Build connector tools dynamically ─────────────────────────────────────
  const integrations = integrationsRes.data || [];
  const githubInt = integrations.find(i => i.provider === "github");
  const notionInt = integrations.find(i => i.provider === "notion");

  const connectorTools: Anthropic.Tool[] = [];

  if (githubInt?.access_token) {
    const login = githubInt.metadata?.login || "your repos";
    connectorTools.push(
      {
        name: "github_list_repos",
        description: `List ${login}'s GitHub repositories sorted by recent activity.`,
        input_schema: { type: "object" as const, properties: {}, required: [] },
      },
      {
        name: "github_list_issues",
        description: "List open issues in a GitHub repository.",
        input_schema: {
          type: "object" as const,
          properties: { repo: { type: "string", description: "owner/repo format" } },
          required: ["repo"],
        },
      },
      {
        name: "github_search_code",
        description: "Search code across GitHub repositories.",
        input_schema: {
          type: "object" as const,
          properties: { query: { type: "string", description: "Code search query" } },
          required: ["query"],
        },
      },
      {
        name: "github_read_file",
        description: "Read the contents of a file from a GitHub repository.",
        input_schema: {
          type: "object" as const,
          properties: {
            repo: { type: "string", description: "owner/repo" },
            path: { type: "string", description: "File path in repo" },
          },
          required: ["repo", "path"],
        },
      },
    );
  }

  if (notionInt?.access_token) {
    connectorTools.push(
      {
        name: "notion_search",
        description: "Search pages in the user's Notion workspace.",
        input_schema: {
          type: "object" as const,
          properties: { query: { type: "string", description: "Search query" } },
          required: ["query"],
        },
      },
      {
        name: "notion_read_page",
        description: "Read the full content of a Notion page by its ID.",
        input_schema: {
          type: "object" as const,
          properties: { page_id: { type: "string", description: "Notion page ID" } },
          required: ["page_id"],
        },
      },
    );
  }

  // Base tools
  const BASE_TOOLS: Anthropic.Tool[] = TAVILY_API_KEY
    ? [{
        name: "web_search",
        description: "Search the web for current, up-to-date information. Use proactively for questions about recent news, events, prices, scores, weather, release dates, or anything time-sensitive. Answer from knowledge for timeless facts.",
        input_schema: {
          type: "object" as const,
          properties: { query: { type: "string", description: "Concise, specific search query" } },
          required: ["query"],
        },
      }]
    : [];

  const TOOLS = [...BASE_TOOLS, ...connectorTools];

  // ── Tool execution ────────────────────────────────────────────────────────
  async function executeTool(blk: Anthropic.ToolUseBlock): Promise<string> {
    try {
      if (blk.name === "web_search") {
        return await executeWebSearch((blk.input as any).query || "");
      }

      if (blk.name.startsWith("github_") && githubInt?.access_token) {
        const token = githubInt.access_token;
        if (blk.name === "github_list_repos") {
          const repos = await githubRequest(token, "/user/repos?sort=pushed&per_page=20");
          return repos.map((r: any) => `${r.full_name} — ${r.description || ""} (${r.language || "?"}, ★${r.stargazers_count})`).join("\n");
        }
        if (blk.name === "github_list_issues") {
          const repo = (blk.input as any).repo;
          const issues = await githubRequest(token, `/repos/${repo}/issues?state=open&per_page=15`);
          return issues.map((i: any) => `#${i.number}: ${i.title} [${i.labels?.map((l: any) => l.name).join(", ") || ""}]`).join("\n");
        }
        if (blk.name === "github_search_code") {
          const q = (blk.input as any).query;
          const result = await githubRequest(token, `/search/code?q=${encodeURIComponent(q)}&per_page=10`);
          return (result.items || []).map((i: any) => `${i.repository?.full_name}/${i.path}`).join("\n");
        }
        if (blk.name === "github_read_file") {
          const { repo, path } = blk.input as any;
          const file = await githubRequest(token, `/repos/${repo}/contents/${path}`);
          const content = file.encoding === "base64" ? atob(file.content.replace(/\n/g, "")) : file.content;
          return content.slice(0, 10000);
        }
      }

      if (blk.name.startsWith("notion_") && notionInt?.access_token) {
        const token = notionInt.access_token;
        if (blk.name === "notion_search") {
          const result = await notionRequest(token, "/search", "POST", {
            query: (blk.input as any).query || "",
            page_size: 8,
            filter: { value: "page", property: "object" },
          });
          return (result.results || []).map((p: any) => {
            const title = p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || "Untitled";
            return `${title} (id: ${p.id})`;
          }).join("\n");
        }
        if (blk.name === "notion_read_page") {
          const pageId = (blk.input as any).page_id;
          const [page, blocks] = await Promise.all([
            notionRequest(token, `/pages/${pageId}`),
            notionRequest(token, `/blocks/${pageId}/children?page_size=100`),
          ]);
          const title = page.properties?.title?.title?.[0]?.plain_text || page.properties?.Name?.title?.[0]?.plain_text || "Untitled";
          return `# ${title}\n\n${extractNotionText(blocks.results || [])}`;
        }
      }

      return "Tool execution failed or not supported.";
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  // ── Format history ────────────────────────────────────────────────────────
  const formattedHistory = historyRaw
    .filter((m: any) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const userContent = buildUserContent(message || "Please analyze the attached file.", attachments);

  let messages: Anthropic.MessageParam[] = [
    ...formattedHistory,
    { role: "user", content: userContent as any },
  ];

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();
  let inputTokens = 0, outputTokens = 0;

  type ToolEvent = { tool: string; input: Record<string, any> };
  const toolEvents: ToolEvent[] = [];
  let toolEventsEmitted = false;

  function emitToolPrefix(controller: ReadableStreamDefaultController) {
    if (toolEventsEmitted) return;
    toolEventsEmitted = true;
    if (toolEvents.length > 0) {
      controller.enqueue(encoder.encode(TOOL_MARK + JSON.stringify(toolEvents) + TOOL_MARK));
    }
  }

  async function finalize(controller: ReadableStreamDefaultController, firstMsg: string, assistantReply = "") {
    const cost = Math.max(
      1,
      Math.ceil((inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output)
    );
    await supaAdmin.from("credit_ledger").insert({
      user_id: user.id,
      delta: -cost,
      reason: "chat_usage",
      team_id: profileRes.data?.team_id ?? null,
      metadata: { model: modelKey, input_tokens: inputTokens, output_tokens: outputTokens },
    });
    const { data: newBal } = await supaAdmin.rpc("get_credit_balance", { p_user_id: user.id });

    // Auto-title
    let title: string | undefined;
    if (historyRaw.length === 0 && firstMsg) {
      try {
        const tr = await anthropic.messages.create({
          model: TITLE_MODEL,
          max_tokens: TITLE_TOKENS,
          messages: [{ role: "user", content: `Generate a 3-6 word title for a chat starting with: "${firstMsg.slice(0, 200)}". Reply with ONLY the title, no quotes or punctuation at the end.` }],
        });
        title = (tr.content.length > 0 ? ((tr.content[0] as any).text || "") : "").trim();
      } catch {}
    }

    // Signed generation receipt: a tamper-evident record of exactly what
    // produced this reply (model, tokens, cost, retrieval/tool context),
    // the generation-side counterpart to the existing deletion receipts.
    // Built from data this function just computed itself, not anything a
    // client supplied -- create_generation_receipt only trusts this
    // service-role caller (see its own migration's comment). Awaited (not
    // fire-and-forget) so the receipt is ready to hand to the client in
    // this same response rather than a follow-up round trip.
    let receipt: { receipt_id: string; payload: unknown; signature: string } | undefined;
    try {
      const { data: receiptData, error: receiptErr } = await supaAdmin.rpc("create_generation_receipt", {
        p_user_id: user.id,
        p_conversation_id: conversationId,
        p_model: modelKey,
        p_requested_model: requestedModel,
        p_input_tokens: inputTokens,
        p_output_tokens: outputTokens,
        p_credits: cost,
        p_sources: {
          tools_used: toolEvents,
          memory_context_count: memoryContextCount,
          document_context_count: documentContextCount,
        },
      });
      if (receiptErr) console.error("chat: create_generation_receipt failed", receiptErr.message);
      else receipt = receiptData as typeof receipt;
    } catch (e) {
      console.error("chat: create_generation_receipt threw", (e as Error).message);
    }

    controller.enqueue(encoder.encode(USAGE_MARK + JSON.stringify({
      balance: newBal,
      title,
      receipt,
      cost: {
        credits: cost,
        model: modelKey,
        requestedModel,
        inputTokens,
        outputTokens,
        inputRate: rates.input,
        outputRate: rates.output,
      },
    })));

    // Low-credit warning + auto-topup (fire-and-forget)
    try {
      if (typeof newBal === "number" && newBal > 0 && newBal <= LOW_CREDIT_THRESHOLD) {
        const { data: prof } = await supaAdmin.from("profiles")
          .select("low_credit_warned_at, auto_topup_enabled").eq("id", user.id).single();
        const lastWarn = prof?.low_credit_warned_at ? new Date(prof.low_credit_warned_at) : null;
        if (!lastWarn || lastWarn < new Date(Date.now() - 86_400_000)) {
          await supaAdmin.functions.invoke("send-low-credit-email", {
            headers: { "X-Internal-Key": SERVICE_ROLE_KEY },
            body: { user_id: user.id, balance: newBal },
          });
          await supaAdmin.from("profiles").update({ low_credit_warned_at: new Date().toISOString() }).eq("id", user.id);
        }
        // Independent of the email cooldown above — auto-topup-charge has
        // its own cooldown guard (see that function) and no-ops cleanly if
        // the user hasn't actually completed setup (no saved payment method).
        if (prof?.auto_topup_enabled) {
          await supaAdmin.functions.invoke("auto-topup-charge", {
            headers: { "X-Internal-Key": SERVICE_ROLE_KEY },
            body: { user_id: user.id },
          });
        }
      } else if (typeof newBal === "number" && newBal <= 0) {
        // A single large reply (e.g. a long Opus response) can skip the
        // 1-30 warning window above entirely and land the balance at 0 or
        // negative in one shot -- found live 2026-10-05: a real account
        // went 47 -> -34 credits in one message and got zero notification
        // of any kind, ever, since low_credit_warned_at above never fires
        // once newBal is <= 0. Own cooldown column so this never competes
        // with the warning email's cooldown.
        const { data: prof } = await supaAdmin.from("profiles")
          .select("credits_depleted_warned_at").eq("id", user.id).single();
        const lastWarn = prof?.credits_depleted_warned_at ? new Date(prof.credits_depleted_warned_at) : null;
        if (!lastWarn || lastWarn < new Date(Date.now() - 86_400_000)) {
          await supaAdmin.functions.invoke("send-low-credit-email", {
            headers: { "X-Internal-Key": SERVICE_ROLE_KEY },
            body: { user_id: user.id, balance: newBal, depleted: true },
          });
          await supaAdmin.from("profiles").update({ credits_depleted_warned_at: new Date().toISOString() }).eq("id", user.id);
        }
      }
    } catch {}

    // Parallel fire-and-forget: JSONB memory extraction + vector memory storage.
    // Must be handed to EdgeRuntime.waitUntil() — without it, Supabase's edge
    // runtime is free to freeze/recycle this isolate the moment controller.close()
    // returns below, silently killing this work before the embed-content calls
    // land (no error, nothing thrown — memory_embeddings just never gets a row).
    if (assistantReply) {
      const backgroundMemoryWork = (async () => {
        try {
          // 1. JSONB structured memory extraction
          const extractRes = await anthropic.messages.create({
            model: TITLE_MODEL,
            max_tokens: 300,
            messages: [{
              role: "user",
              content: `You are a memory extractor for an AI assistant. Extract NEW facts about the user from this exchange.

Known facts: ${JSON.stringify(existingMemory)}

User said: "${firstMsg.slice(0, 600)}"
Assistant replied: "${assistantReply.slice(0, 600)}"

Return a JSON object with only NEW or UPDATED fields from: name, occupation, company, location, preferences (string[]), projects (string[]), facts (string[]). Return {} if nothing new. JSON only, no explanation.`,
            }],
          });
          const raw = (extractRes.content[0] as any)?.text?.trim() || "";
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const incoming = JSON.parse(match[0]) as Partial<UserMemory>;
            if (incoming && Object.keys(incoming).length) {
              const merged = mergeMemory(existingMemory, incoming);
              await supaAdmin.from("profiles").update({ memory: merged }).eq("id", user.id);
            }
          }
        } catch {}

        // 2. Vector memory: embed + store both turns
        if (VOYAGE_API_KEY) {
          try {
            await supaAdmin.functions.invoke("embed-content", {
              headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
              body: {
                type: "memory",
                role: "user",
                content: firstMsg.slice(0, 2000),
                conversation_id: conversationId,
                user_id: user.id,
              },
            });
            await supaAdmin.functions.invoke("embed-content", {
              headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
              body: {
                type: "memory",
                role: "assistant",
                content: assistantReply.slice(0, 2000),
                conversation_id: conversationId,
                user_id: user.id,
              },
            });
          } catch {}
        }
      })();
      // @ts-ignore — EdgeRuntime is a Supabase/Deno Deploy Edge Functions global,
      // not part of standard Deno types. Falls back to a plain await (blocking
      // the response) if it's ever missing, e.g. local `supabase functions serve`.
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(backgroundMemoryWork);
      } else {
        await backgroundMemoryWork;
      }
    }

    controller.close();
  }

  // ── Streaming response ────────────────────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (TOOLS.length > 0) {
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const r = await anthropic.messages.create({
              model: MODEL,
              max_tokens: MAX_TOKENS,
              system: systemPrompt,
              messages,
              tools: TOOLS,
              tool_choice: { type: "auto" },
            });
            inputTokens += r.usage.input_tokens;
            outputTokens += r.usage.output_tokens;

            if (r.stop_reason !== "tool_use") {
              emitToolPrefix(controller);
              const text = r.content.filter(b => b.type === "text").map(b => (b as any).text).join("");
              controller.enqueue(encoder.encode(text));
              await finalize(controller, message, text);
              return;
            }

            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const blk of r.content) {
              if (blk.type !== "tool_use") continue;
              const result = await executeTool(blk);
              toolEvents.push({ tool: blk.name, input: blk.input as Record<string, any> });
              toolResults.push({ type: "tool_result", tool_use_id: blk.id, content: result });
            }

            messages = [
              ...messages,
              { role: "assistant", content: r.content },
              { role: "user", content: toolResults },
            ];
          }
        }

        emitToolPrefix(controller);

        const supportsThinking = MODEL === MODEL_MAP.sonnet || MODEL === MODEL_MAP.opus;
        const finalStream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: supportsThinking ? MAX_TOKENS_THINKING : MAX_TOKENS,
          system: systemPrompt,
          messages,
          ...(supportsThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
        } as any);

        let fullText = "";
        let thinkingText = "";
        let thinkingEmitted = false;

        for await (const chunk of finalStream) {
          if (chunk.type === "content_block_delta") {
            if (chunk.delta.type === "thinking_delta") {
              thinkingText += chunk.delta.thinking;
            } else if (chunk.delta.type === "text_delta") {
              if (!thinkingEmitted && thinkingText) {
                controller.enqueue(encoder.encode(THINK_MARK + thinkingText + THINK_MARK));
                thinkingEmitted = true;
              }
              controller.enqueue(encoder.encode(chunk.delta.text));
              fullText += chunk.delta.text;
            }
          }
        }

        const finalMsg = await finalStream.finalMessage();
        inputTokens += finalMsg.usage.input_tokens;
        outputTokens += finalMsg.usage.output_tokens;

        await finalize(controller, message, fullText);
      } catch (e) {
        try {
          controller.enqueue(encoder.encode(USAGE_MARK + JSON.stringify({ error: "Server error: " + (e as Error).message })));
        } catch {}
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...CORS,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
});
