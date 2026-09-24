// chat v21 — tool use (web search via Tavily) + streaming agentic loop
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.24.3?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const TAVILY_API_KEY = Deno.env.get("TAVILY_API_KEY"); // optional — search disabled if absent

const MODEL = "claude-opus-5-5";
const TITLE_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 4096;
const TITLE_TOKENS = 80;
const LOW_CREDIT_THRESHOLD = 30;
const MAX_ATTACHMENTS = 3;
const MAX_TOOL_ROUNDS = 3;

// Protocol delimiters (single bytes, never appear in normal UTF-8 prose)
const TOOL_MARK = "\x01"; // wraps tool-events JSON: \x01[...]\x01 then text
const USAGE_MARK = "\x00"; // separates text from trailing metadata JSON

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = TAVILY_API_KEY
  ? [
      {
        name: "web_search",
        description:
          "Search the web for current, up-to-date information. Use proactively for questions about recent news, events, prices, scores, weather, release dates, or anything time-sensitive. Answer from knowledge for timeless facts.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Concise, specific search query" },
          },
          required: ["query"],
        },
      },
    ]
  : [];

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
      out +=
        "Sources:\n" +
        data.results
          .slice(0, 5)
          .map(
            (r: any, i: number) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${(r.content || "").slice(0, 400)}`
          )
          .join("\n\n");
    }
    return (out.slice(0, 8000)) || "No results found.";
  } catch (_) {
    return "Search timed out or failed.";
  }
}

// ── Attachment helpers ──────────────────────────────────────────────────────

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

function buildUserContent(
  message: string,
  attachments: Attachment[]
): string | ContentBlock[] {
  if (!attachments.length) return message;
  const blocks: ContentBlock[] = [];
  for (const att of attachments.slice(0, MAX_ATTACHMENTS)) {
    if (att.type === "image" && att.data && att.mediaType) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mediaType as any, data: att.data },
      });
    } else if (att.type === "text" && att.content != null) {
      blocks.push({
        type: "text",
        text: `[Attached file: ${att.filename}]\n---\n${att.content.slice(0, 30000)}\n---`,
      });
    }
  }
  blocks.push({ type: "text", text: message });
  return blocks;
}

// ── Main handler ───────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  // Auth
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
  if (!jwt)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const {
    data: { user },
    error: userErr,
  } = await supaUser.auth.getUser();
  if (userErr || !user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Parse body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const message: string = (body.message || "").trim();
  const historyRaw: { role: string; content: string }[] = Array.isArray(body.history)
    ? body.history
    : [];
  const attachments: Attachment[] = Array.isArray(body.attachments)
    ? body.attachments.slice(0, MAX_ATTACHMENTS)
    : [];

  if (!message && !attachments.length)
    return new Response(JSON.stringify({ error: "Empty message" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  // Credit check
  const { data: balance } = await supaAdmin.rpc("get_credit_balance", {
    p_user_id: user.id,
  });
  if (typeof balance === "number" && balance <= 0)
    return new Response(JSON.stringify({ error: "No credits", balance: 0 }), {
      status: 402,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  // System prompt + workspace context
  let systemPrompt =
    "You are Aethyro, a highly capable AI assistant." +
    (TAVILY_API_KEY
      ? " You have a web_search tool — use it proactively whenever the user asks about current events, recent news, live data, prices, sports results, release dates, or anything that may have changed since your training cutoff. For timeless knowledge, answer directly."
      : "");
  try {
    const { data: profile } = await supaAdmin
      .from("profiles")
      .select("workspace_context")
      .eq("id", user.id)
      .single();
    if (profile?.workspace_context) {
      systemPrompt += `\n\n--- User context ---\n${profile.workspace_context}`;
    }
  } catch (_) {}

  // Format history (last 20 turns, user/assistant only)
  const formattedHistory: { role: "user" | "assistant"; content: string }[] = historyRaw
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const userContent = buildUserContent(
    message || "Please analyze the attached file.",
    attachments
  );

  let messages: Anthropic.MessageParam[] = [
    ...formattedHistory,
    { role: "user", content: userContent as any },
  ];

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();

  // Accumulated token counts for billing
  let inputTokens = 0;
  let outputTokens = 0;

  // Tool events emitted to client
  type ToolEvent = { tool: string; input: Record<string, any> };
  const toolEvents: ToolEvent[] = [];
  let toolEventsEmitted = false;

  // Helper: emit tool events prefix exactly once, before first text
  function emitToolPrefix(controller: ReadableStreamDefaultController) {
    if (toolEventsEmitted) return;
    toolEventsEmitted = true;
    if (toolEvents.length > 0) {
      controller.enqueue(
        encoder.encode(TOOL_MARK + JSON.stringify(toolEvents) + TOOL_MARK)
      );
    }
  }

  // Helper: post-response billing + metadata
  async function finalize(controller: ReadableStreamDefaultController, firstMsg: string) {
    const cost = Math.max(
      1,
      Math.ceil((inputTokens / 1000) * 1.5 + (outputTokens / 1000) * 7.5)
    );
    await supaAdmin.from("credit_ledger").insert({
      user_id: user.id,
      delta: -cost,
      reason: "chat_usage",
    });
    const { data: newBal } = await supaAdmin.rpc("get_credit_balance", {
      p_user_id: user.id,
    });

    // Auto-title on first exchange
    let title: string | undefined;
    if (historyRaw.length === 0 && firstMsg) {
      try {
        const tr = await anthropic.messages.create({
          model: TITLE_MODEL,
          max_tokens: TITLE_TOKENS,
          messages: [
            {
              role: "user",
              content: `Generate a 3-6 word title for a chat starting with: "${firstMsg.slice(0, 200)}". Reply with ONLY the title, no quotes or punctuation at the end.`,
            },
          ],
        });
        title = ((tr.content[0] as any).text || "").trim();
      } catch (_) {}
    }

    controller.enqueue(
      encoder.encode(USAGE_MARK + JSON.stringify({ balance: newBal, title }))
    );

    // Low-credit warning email (fire-and-forget)
    try {
      if (typeof newBal === "number" && newBal > 0 && newBal <= LOW_CREDIT_THRESHOLD) {
        const { data: prof } = await supaAdmin
          .from("profiles")
          .select("low_credit_warned_at")
          .eq("id", user.id)
          .single();
        const lastWarn = prof?.low_credit_warned_at
          ? new Date(prof.low_credit_warned_at)
          : null;
        if (!lastWarn || lastWarn < new Date(Date.now() - 86_400_000)) {
          await supaAdmin.functions.invoke("send-low-credit-email", {
            body: { user_id: user.id, balance: newBal },
          });
          await supaAdmin
            .from("profiles")
            .update({ low_credit_warned_at: new Date().toISOString() })
            .eq("id", user.id);
        }
      }
    } catch (_) {}

    controller.close();
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // ── Agentic tool-use rounds (non-streaming, up to MAX_TOOL_ROUNDS) ──
        if (TOOLS.length > 0) {
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            // Non-streaming call so we can inspect stop_reason before emitting anything
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
              // Claude answered directly (didn't use a tool this round).
              // Emit text — no streaming for this path, but that's acceptable since
              // this only triggers when tools were configured but not called.
              emitToolPrefix(controller);
              const text = r.content
                .filter((b) => b.type === "text")
                .map((b) => (b as any).text)
                .join("");
              controller.enqueue(encoder.encode(text));
              await finalize(controller, message);
              return;
            }

            // Execute each tool call
            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const blk of r.content) {
              if (blk.type !== "tool_use") continue;
              let result = "";
              if (blk.name === "web_search") {
                const q = (blk.input as any).query || "";
                result = await executeWebSearch(q);
                toolEvents.push({ tool: "web_search", input: { query: q } });
              }
              toolResults.push({
                type: "tool_result",
                tool_use_id: blk.id,
                content: result,
              });
            }

            messages = [
              ...messages,
              { role: "assistant", content: r.content },
              { role: "user", content: toolResults },
            ];
          }
        }

        // ── Final streaming response (after all tool rounds, or if no tools) ──
        // Emit accumulated tool events prefix before first text byte
        emitToolPrefix(controller);

        const finalStream = anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages,
          // No tools on final answer — prevents infinite loops
        });

        let firstChunk = true;
        let fullText = "";
        for await (const chunk of finalStream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            if (firstChunk) {
              // If no tools were called, emitToolPrefix is already a no-op here
              firstChunk = false;
            }
            controller.enqueue(encoder.encode(chunk.delta.text));
            fullText += chunk.delta.text;
          }
        }

        const finalMsg = await finalStream.finalMessage();
        inputTokens += finalMsg.usage.input_tokens;
        outputTokens += finalMsg.usage.output_tokens;

        await finalize(controller, message);
      } catch (e) {
        try {
          controller.enqueue(
            encoder.encode(
              USAGE_MARK + JSON.stringify({ error: "Server error: " + (e as Error).message })
            )
          );
        } catch (_) {}
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
