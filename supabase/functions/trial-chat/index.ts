import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import { completeWithFailover } from "../_shared/llm.ts";

// Public, unauthenticated preview endpoint for the homepage inline try-box
// and chat.html's anonymous trial mode. Gated solely by a per-IP daily
// counter (3 messages/day) — no Turnstile token required.
//
// v17 — now goes through the shared multi-provider module
// (_shared/llm.ts): if Claude is down, automatically fails over to
// OpenAI (gpt-5.4-pro, matching this endpoint's existing opus-tier
// model) rather than erroring outright. No explicit model choice here
// (this endpoint has never had a model picker) — pure availability
// improvement, same preview behavior either way.
// Note (2026-10-30): the OpenAI side of that fallback is now gpt-5.4, not
// gpt-5.4-pro — see _shared/llm.ts's own header comment for why.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY"); // optional -- undefined just means no fallback available
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const ANTHROPIC_MODEL = "claude-opus-5";
const MAX_TOKENS = 400;
const DAILY_LIMIT_PER_IP = 3;
const MAX_MESSAGE_LEN = 600;

const SYSTEM_PROMPT = `You are Aethyro, a private AI assistant that helps with code, research, writing, strategy, and everyday problem-solving. This is a free, unauthenticated preview embedded on the homepage — keep answers short and concrete (a few sentences, or a short code snippet), and if the question deserves a longer answer, give the most useful short version and mention that signing up unlocks full-length, ongoing conversations.`;

// CORS locked to aethyro.com (+ preview subdomains); was a bare "*". See
// chat/index.ts v48's comment for the rationale. This endpoint is only
// ever called from the homepage inline try-box and chat.html's anonymous
// trial mode, both aethyro.com pages, so this doesn't change its real
// usage pattern.
const ALLOWED_ORIGINS = ["https://aethyro.com", "https://www.aethyro.com"];
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-aethyro-landing\.[a-z0-9-]+\.workers\.dev$/;
function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "apikey, content-type",
    "Vary": "Origin",
  };
}

const USAGE_MARK = "\u0000";

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  let body: { message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: CORS });
  }

  const message = (body.message ?? "").trim().slice(0, MAX_MESSAGE_LEN);
  if (!message) return new Response(JSON.stringify({ error: "message is required" }), { status: 400, headers: CORS });

  const ip = getClientIp(req);
  const today = new Date().toISOString().slice(0, 10);

  const { data: newCount, error: rpcErr } = await supabase.rpc("increment_trial_usage", {
    p_ip: ip,
    p_day: today,
  });
  if (rpcErr) {
    return new Response(JSON.stringify({ error: `rate limit check failed: ${rpcErr.message}` }), { status: 500, headers: CORS });
  }

  if ((newCount as number) > DAILY_LIMIT_PER_IP) {
    return new Response(
      JSON.stringify({ error: "trial_limit_reached" }),
      { status: 429, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  const remaining = DAILY_LIMIT_PER_IP - (newCount as number);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let errorMessage: string | null = null;

      try {
        let streamedText = "";
        const result = await completeWithFailover(supabase, ANTHROPIC_API_KEY, OPENAI_API_KEY, {
          modelKey: "opus",
          anthropicModel: ANTHROPIC_MODEL,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: message }],
          maxTokens: MAX_TOKENS,
          onTextDelta: (text) => {
            controller.enqueue(enc.encode(text));
            streamedText += text;
          },
        });

        // Broadened beyond the original "refusal"-only check (found live
        // 2026-10-08 investigating a real user report of a dead-end "(no
        // response)" on an unusual prompt): Claude can occasionally land on
        // a stop_reason other than the literal "refusal" while still
        // emitting zero visible text, and the old check silently fell
        // through to chat.html's generic "(no response)" fallback with no
        // explanation either way.
        if (!streamedText.trim()) {
          errorMessage = result.stopReason === "refusal"
            ? "Aethyro declined to answer that request."
            : "Aethyro didn't generate a reply to that — try rephrasing your question.";
        } else if (result.stopReason === "max_tokens") {
          // The free preview's 400-token cap can cut a real answer off
          // mid-sentence with no indication to the user that it was
          // truncated rather than just ending there. Append a visible note
          // so it reads as an intentional preview limit, not a broken reply.
          const note = "\n\n*(cut short — this is the free preview; [sign up](/app/signup.html) for full-length answers)*";
          controller.enqueue(enc.encode(note));
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        console.error("trial chat error", errorMessage);
      }

      controller.enqueue(
        enc.encode(`${USAGE_MARK}${JSON.stringify({ remaining, error: errorMessage })}`)
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
  });
});
