// api-chat — Phase 2 of the site-expansion pass: a public, metered chat
// completions endpoint. Lets a user call Aethyro's models from their own
// code with a long-lived API key (created via the create_api_key() RPC,
// public.api_keys) instead of a browser session. Stateless: the caller
// sends the full message history each request, same shape as most public
// LLM completion APIs -- Aethyro doesn't keep server-side conversation
// state for this path the way chat.html's `chat` function does.
//
// verify_jwt: false -- auth is the API key itself (Authorization: Bearer
// ak_live_...), not a Supabase session, since callers have no Aethyro
// account context beyond the key. Same "custom auth in the function body"
// exemption webhook-routine-trigger already uses.
//
// v4 (2026-10-08) -- closes 3 of developers.html's documented "known v1
// gaps": model:"auto" routing (reuses chat/index.ts's embedding classifier
// verbatim, including its heuristic fallback), stream:true (standard SSE,
// not chat.html's internal marker-byte framing -- this is a public API for
// arbitrary external clients, so it uses the conventional `data: {...}\n\n`
// + `data: [DONE]\n\n` shape instead), and a lifetime-purchase rate-limit
// tier (an account that has ever bought the Power or Pro pack gets a
// higher per-minute cap than the flat default -- a cheap, defensible
// reading of "favor paying users" that needed no new schema: it's a
// straight read of existing credit_ledger purchase rows). Per-key rate
// limit still shares increment_rate_limit() RPC with chat's own limiter.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.24.3?target=deno";

// CORS locked to aethyro.com (+ preview subdomains); was a bare "*". See
// chat/index.ts v48's comment for the rationale. Doesn't affect this
// function's real documented usage pattern (server-side scripts/backends
// calling with an API key) -- CORS is a browser-only enforcement
// mechanism, so a non-browser caller is never gated by this header either
// way.
const ALLOWED_ORIGINS = ["https://aethyro.com", "https://www.aethyro.com"];
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-aethyro-landing\.[a-z0-9-]+\.workers\.dev$/;
function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const VOYAGE_API_KEY    = Deno.env.get("VOYAGE_API_KEY");

const MODEL_MAP: Record<string, string> = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus:   "claude-opus-5-5",
};
const CREDIT_RATES: Record<string, { input: number; output: number }> = {
  haiku:  { input: 0.08,  output: 0.40 },
  sonnet: { input: 0.30,  output: 1.50 },
  opus:   { input: 1.50,  output: 7.50 },
};
const VOYAGE_MODEL = "voyage-4-lite";

const MAX_TOKENS = 4096;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;
const API_RATE_LIMIT_DEFAULT = 30;
// Lifetime Power/Pro pack purchaser tier -- a one-time real purchase, not a
// recurring subscription this product doesn't have, so this checks
// credit_ledger history rather than any notion of an active "plan".
const API_RATE_LIMIT_PRO = 90;
const PRO_TIER_PACKS = ["power", "pro_7k"];

// Same rule-based router as chat/index.ts's routeAutoModel() -- kept
// byte-for-byte equivalent in spirit (no attachments param here, since
// api-chat has no file-upload path) so model:"auto" behaves the same way
// a developer would already expect from using chat.html.
const AUTO_HEAVY_SIGNALS = [
  "audit", "security", "vulnerab", "architecture", "refactor", "debug",
  "prove", "optimi", "algorithm", "strategy", "analyz", "analysis",
  "contract", "legal", "compliance", "research", "comprehensive",
  "in-depth", "in depth", "detailed plan", "step by step", "step-by-step",
  "compare", "pros and cons", "root cause", "design a", "write a full",
];
const AUTO_LIGHT_RE = /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|sure|yes|no|got it|sounds good|np|k)\b[.!?]*$/i;

function routeAutoModel(message: string): "haiku" | "sonnet" | "opus" {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const len = trimmed.length;

  const isHeavy = len > 500 || AUTO_HEAVY_SIGNALS.some(s => lower.includes(s));
  if (isHeavy) return "opus";

  const isLight = len > 0 && len <= 40 && (AUTO_LIGHT_RE.test(trimmed) || (!/[?]/.test(trimmed) && len <= 15));
  if (isLight) return "haiku";

  return "sonnet";
}

async function embedText(text: string): Promise<number[] | null> {
  if (!VOYAGE_API_KEY) return null;
  try {
    const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${VOYAGE_API_KEY}` },
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

// Same classifier chat/index.ts uses: nearest-centroid lookup via
// classify_router_tier() (pgvector, public.model_router_centroids),
// falling back to the keyword/length heuristic whenever no embedding is
// available or the RPC itself fails -- must never be a single point of
// failure for a billed request.
async function classifyModelFromEmbedding(
  supaAdmin: ReturnType<typeof createClient>,
  embedding: number[] | null,
  message: string,
): Promise<"haiku" | "sonnet" | "opus"> {
  let tier: "light" | "medium" | "heavy" | null = null;
  if (embedding) {
    const { data, error } = await supaAdmin.rpc("classify_router_tier", { p_embedding: embedding });
    if (!error && (data === "light" || data === "medium" || data === "heavy")) tier = data;
  }
  if (!tier) return routeAutoModel(message);

  const lower = message.trim().toLowerCase();
  if (AUTO_HEAVY_SIGNALS.some(s => lower.includes(s))) tier = "heavy";

  return tier === "light" ? "haiku" : tier === "heavy" ? "opus" : "sonnet";
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim() || req.headers.get("X-API-Key") || "";
  if (!apiKey || !apiKey.startsWith("ak_live_")) {
    return json({ error: "Missing or malformed API key. Pass it as: Authorization: Bearer ak_live_..." }, 401);
  }

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const keyHash = await sha256Hex(apiKey);

  const { data: keyRow, error: keyErr } = await supaAdmin
    .from("api_keys")
    .select("id, user_id, request_count")
    .eq("key_hash", keyHash)
    .single();
  if (keyErr || !keyRow) {
    return json({ error: "Invalid or revoked API key" }, 401);
  }

  // Tiered per-key rate limit: a lifetime Power/Pro pack purchase (a real,
  // one-time purchase row in credit_ledger -- this product has no
  // recurring subscriptions to check against) raises the cap. Fails
  // closed to the default limit on a lookup error -- never silently grants
  // the higher tier.
  let rateLimitCap = API_RATE_LIMIT_DEFAULT;
  {
    const { data: proPurchase, error: proErr } = await supaAdmin
      .from("credit_ledger")
      .select("id")
      .eq("user_id", keyRow.user_id)
      .eq("reason", "purchase")
      .in("metadata->>credit_pack", PRO_TIER_PACKS)
      .limit(1);
    if (!proErr && proPurchase && proPurchase.length > 0) rateLimitCap = API_RATE_LIMIT_PRO;
  }

  // Per-key rate limit, same fixed-window RPC `chat` uses. Fails open on an
  // RPC error rather than blocking a legitimate call on an infra hiccup.
  {
    const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const { data: rlCount, error: rlErr } = await supaAdmin.rpc("increment_rate_limit", {
      p_key_type: "api_key", p_key_value: keyRow.id, p_window_start: windowStart,
    });
    if (rlErr) {
      console.error("api-chat: rate limit check failed", rlErr.message);
    } else if (typeof rlCount === "number" && rlCount > rateLimitCap) {
      return new Response(JSON.stringify({ error: "Too many requests, please slow down" }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json", "Retry-After": "60" },
      });
    }
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  let messages: { role: string; content: string }[];
  if (Array.isArray(body?.messages)) {
    messages = body.messages;
  } else if (typeof body?.message === "string") {
    messages = [{ role: "user", content: body.message }];
  } else {
    return json({ error: "Body must include either \"message\" (string) or \"messages\" (array of {role, content})" }, 400);
  }

  if (messages.length === 0 || messages.length > MAX_MESSAGES) {
    return json({ error: `messages must contain 1-${MAX_MESSAGES} entries` }, 400);
  }
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) {
      return json({ error: "Each message needs role: \"user\"|\"assistant\" and non-empty string content" }, 400);
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return json({ error: `Each message's content must be ${MAX_MESSAGE_CHARS} characters or fewer` }, 400);
    }
  }
  if (messages[messages.length - 1].role !== "user") {
    return json({ error: "The last message must have role \"user\"" }, 400);
  }

  const requestedModel = typeof body?.model === "string" ? body.model : "sonnet";
  let modelKey: "haiku" | "sonnet" | "opus";
  if (requestedModel === "auto") {
    const lastUserMessage = messages[messages.length - 1].content;
    const embedding = await embedText(lastUserMessage);
    modelKey = await classifyModelFromEmbedding(supaAdmin, embedding, lastUserMessage);
  } else if (requestedModel === "haiku" || requestedModel === "sonnet" || requestedModel === "opus") {
    modelKey = requestedModel;
  } else {
    modelKey = "sonnet";
  }
  const model = MODEL_MAP[modelKey];
  const rates = CREDIT_RATES[modelKey];

  const { data: rawBalance } = await supaAdmin.rpc("get_credit_balance", { p_user_id: keyRow.user_id });
  const balance = typeof rawBalance === "number" ? rawBalance : 0;
  if (balance <= 0) {
    return json({ error: "Insufficient credits" }, 402);
  }

  const { data: profile } = await supaAdmin
    .from("profiles").select("team_id").eq("id", keyRow.user_id).single();

  const streamRequested = body?.stream === true;

  async function bill(inputTokens: number, outputTokens: number): Promise<{ cost: number; newBalance: number | null }> {
    const cost = Math.max(
      1,
      Math.ceil((inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output),
    );
    const { error: ledgerErr } = await supaAdmin.from("credit_ledger").insert({
      user_id: keyRow.user_id,
      delta:   -cost,
      reason:  "api_usage",
      team_id: profile?.team_id ?? null,
      metadata: { model: modelKey, requested_model: requestedModel, input_tokens: inputTokens, output_tokens: outputTokens, api_key_id: keyRow.id },
    });
    if (ledgerErr) console.error("api-chat: credit_ledger insert failed", ledgerErr.message);

    // Non-critical analytics counters -- a lost update under concurrent
    // requests from the same key is an acceptable race here, unlike billing.
    await supaAdmin.from("api_keys").update({
      last_used_at: new Date().toISOString(),
      request_count: (keyRow.request_count || 0) + 1,
    }).eq("id", keyRow.id);

    const { data: newBalance } = await supaAdmin.rpc("get_credit_balance", { p_user_id: keyRow.user_id });
    return { cost, newBalance: typeof newBalance === "number" ? newBalance : null };
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const systemPrompt = "You are Aethyro, accessed via the public Aethyro API. Be direct, accurate, and concise unless asked for more detail.";

  if (streamRequested) {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream({
      async start(controller) {
        function send(obj: unknown) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        }
        try {
          const anthropicStream = anthropic.messages.stream({
            model, max_tokens: MAX_TOKENS, system: systemPrompt, messages,
          });
          let fullText = "";
          for await (const chunk of anthropicStream) {
            if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
              fullText += chunk.delta.text;
              send({ type: "delta", text: chunk.delta.text });
            }
          }
          const finalMsg = await anthropicStream.finalMessage();
          const { cost, newBalance } = await bill(finalMsg.usage.input_tokens, finalMsg.usage.output_tokens);
          send({
            type: "done",
            model: modelKey,
            ...(requestedModel === "auto" ? { requested_model: "auto" } : {}),
            content: fullText,
            usage: { input_tokens: finalMsg.usage.input_tokens, output_tokens: finalMsg.usage.output_tokens },
            credits_charged: cost,
            credits_remaining: newBalance,
          });
        } catch (e) {
          console.error("api-chat: streaming Anthropic call failed", (e as Error).message);
          send({ type: "error", error: "Upstream model error" });
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(sseBody, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  let msg;
  try {
    msg = await anthropic.messages.create({ model, max_tokens: MAX_TOKENS, system: systemPrompt, messages });
  } catch (e) {
    console.error("api-chat: Anthropic call failed", (e as Error).message);
    return json({ error: "Upstream model error" }, 502);
  }

  const resultBlock = msg.content.find(b => b.type === "text") as any;
  const content = resultBlock?.text || "";

  const { cost, newBalance } = await bill(msg.usage.input_tokens, msg.usage.output_tokens);

  return json({
    model: modelKey,
    ...(requestedModel === "auto" ? { requested_model: "auto" } : {}),
    content,
    usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    credits_charged: cost,
    credits_remaining: newBalance,
  });
});
