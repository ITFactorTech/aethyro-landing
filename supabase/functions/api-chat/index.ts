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
// Per-key rate limit: 30 req/min, shared increment_rate_limit() RPC with
// chat (see that migration) -- closes the gap this comment used to
// document as unsolved.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.24.3?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

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

const MAX_TOKENS = 4096;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;
const API_RATE_LIMIT_PER_MINUTE = 30;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
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

  // Per-key rate limit, same fixed-window RPC `chat` uses. Fails open on an
  // RPC error rather than blocking a legitimate call on an infra hiccup.
  {
    const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const { data: rlCount, error: rlErr } = await supaAdmin.rpc("increment_rate_limit", {
      p_key_type: "api_key", p_key_value: keyRow.id, p_window_start: windowStart,
    });
    if (rlErr) {
      console.error("api-chat: rate limit check failed", rlErr.message);
    } else if (typeof rlCount === "number" && rlCount > API_RATE_LIMIT_PER_MINUTE) {
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

  const modelKey = ["haiku", "sonnet", "opus"].includes(body?.model) ? body.model : "sonnet";
  const model = MODEL_MAP[modelKey];
  const rates = CREDIT_RATES[modelKey];

  const { data: rawBalance } = await supaAdmin.rpc("get_credit_balance", { p_user_id: keyRow.user_id });
  const balance = typeof rawBalance === "number" ? rawBalance : 0;
  if (balance <= 0) {
    return json({ error: "Insufficient credits" }, 402);
  }

  const { data: profile } = await supaAdmin
    .from("profiles").select("team_id").eq("id", keyRow.user_id).single();

  let msg;
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    msg = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: "You are Aethyro, accessed via the public Aethyro API. Be direct, accurate, and concise unless asked for more detail.",
      messages,
    });
  } catch (e) {
    console.error("api-chat: Anthropic call failed", (e as Error).message);
    return json({ error: "Upstream model error" }, 502);
  }

  const resultBlock = msg.content.find(b => b.type === "text") as any;
  const content = resultBlock?.text || "";

  const cost = Math.max(
    1,
    Math.ceil(
      (msg.usage.input_tokens  / 1000) * rates.input +
      (msg.usage.output_tokens / 1000) * rates.output,
    ),
  );
  const { error: ledgerErr } = await supaAdmin.from("credit_ledger").insert({
    user_id: keyRow.user_id,
    delta:   -cost,
    reason:  "api_usage",
    team_id: profile?.team_id ?? null,
    metadata: { model: modelKey, input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, api_key_id: keyRow.id },
  });
  if (ledgerErr) console.error("api-chat: credit_ledger insert failed", ledgerErr.message);

  // Non-critical analytics counters -- a lost update under concurrent
  // requests from the same key is an acceptable race here, unlike billing.
  await supaAdmin.from("api_keys").update({
    last_used_at: new Date().toISOString(),
    request_count: (keyRow.request_count || 0) + 1,
  }).eq("id", keyRow.id);

  const { data: newBalance } = await supaAdmin.rpc("get_credit_balance", { p_user_id: keyRow.user_id });

  return json({
    model: modelKey,
    content,
    usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    credits_charged: cost,
    credits_remaining: typeof newBalance === "number" ? newBalance : null,
  });
});
