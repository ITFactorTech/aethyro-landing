// Multi-provider LLM completion: Anthropic primary, OpenAI fallback/variety.
//
// Tools: a caller may pass `tools` + `executeTool`; the OpenAI leg then runs
// a function-calling loop (_shared/openai_tools.ts) so GPT can use the same
// tools Claude does (web search, page fetch, GitHub, Notion). The Anthropic
// leg here stays tools-free -- chat/index.ts runs Claude's own tool loop
// itself and only reaches this module when that path is bypassed (explicit
// "gpt" pick) or has failed. Which tools a given path may offer is the
// CALLER's decision, not this module's (chat deliberately withholds the
// GitHub/Notion connector tools from the automatic Claude-down fallback --
// see chat/index.ts). Image/document attachment blocks are still flattened
// to text on the OpenAI path. Thinking/extended-reasoning is Anthropic-only;
// an OpenAI-served turn simply produces no thinking content, which every
// caller already handles gracefully (the reasoning panel just doesn't show).
//
// Circuit breaker: public.provider_health (provider text primary key,
// consecutive_failures int, opened_until timestamptz). A provider trips
// "open" after CIRCUIT_FAILURE_THRESHOLD consecutive failures and stays
// open (skipped entirely, no live retry) until opened_until passes --
// this means a real outage only costs one slow timeout per threshold-
// count of requests, not one per request.
//
// Billing note (by design, confirmed with the product owner): a reply
// that lands on OpenAI -- whether by explicit "gpt" pick or automatic
// failover -- is billed at the SAME credit rate as the Claude tier it
// stands in for (CREDIT_RATES[modelKey] in chat/index.ts and
// trial-chat's own simpler flat-preview billing), not a separate
// OpenAI-cost-accurate rate. Keeps pricing.html's published rates
// correct regardless of which provider actually answered.

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.32?target=deno";
import OpenAI from "https://esm.sh/openai@4?target=deno";
import { runOpenAIToolLoop, type ToolDef } from "./openai_tools.ts";
import {
  OPENAI_MODEL_MAP, isCircuitOpen, recordFailure, recordSuccess,
  type ModelKey, type Provider,
} from "./failover.ts";

// Circuit breaker, model map and shared types live in failover.ts (also used by
// run-routines / run-agent-task); re-exported so existing imports keep working.
export { OPENAI_MODEL_MAP };
export type { ToolDef, ModelKey, Provider };
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";


export interface CompletionRequest {
  modelKey: ModelKey;
  anthropicModel: string;       // chat/trial-chat's own MODEL_MAP[modelKey]
  system: string;
  messages: { role: "user" | "assistant"; content: unknown }[]; // Anthropic-shaped; converted internally for the OpenAI path
  maxTokens: number;
  thinking?: boolean;           // caller already decided supportsThinking; Anthropic-only
  forceProvider?: Provider;     // explicit pick -- "openai" skips Anthropic/the circuit breaker entirely
  onTextDelta: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  // OpenAI leg only (see header). Omit or pass [] for a plain completion.
  tools?: ToolDef[];
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onFinalStart?: () => void;    // fires just before the first answer text on a tool-enabled OpenAI turn
}

export interface CompletionResult {
  provider: Provider;
  model: string;          // the real model id that actually answered
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;     // normalized: "end_turn" | "max_tokens" | "refusal" | other Anthropic-shaped reasons
}

// Anthropic content can be a plain string or an array of blocks (text,
// tool_result, image, document). OpenAI's Chat Completions message shape
// wants plain string content -- flatten to text-only, which is the
// documented v1 limitation (no images/tool-results carried into an
// OpenAI-served turn).
function flattenToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((blk: any) => {
        if (typeof blk?.text === "string") return blk.text;
        if (typeof blk?.content === "string") return blk.content;
        if (Array.isArray(blk?.content)) return flattenToText(blk.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function runAnthropic(apiKey: string, req: CompletionRequest): Promise<CompletionResult> {
  const anthropic = new Anthropic({ apiKey });
  const stream = anthropic.messages.stream({
    model: req.anthropicModel,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages as any,
    ...(req.thinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
  } as any);

  let fullText = "";
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta") {
      if (chunk.delta.type === "thinking_delta") {
        req.onThinkingDelta?.(chunk.delta.thinking);
      } else if (chunk.delta.type === "text_delta") {
        fullText += chunk.delta.text;
        req.onTextDelta(chunk.delta.text);
      }
    }
  }
  const final = await stream.finalMessage();
  return {
    provider: "anthropic",
    model: req.anthropicModel,
    fullText,
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
    stopReason: final.stop_reason ?? "end_turn",
  };
}

function finishToStopReason(finishReason: string): string {
  return finishReason === "length" ? "max_tokens" : finishReason === "content_filter" ? "refusal" : "end_turn";
}

async function runOpenAI(apiKey: string, req: CompletionRequest): Promise<CompletionResult> {
  const openai = new OpenAI({ apiKey });
  const model = OPENAI_MODEL_MAP[req.modelKey];

  const flatMessages = req.messages.map((m) => ({ role: m.role, content: flattenToText(m.content) }));

  if (req.tools?.length && req.executeTool) {
    const r = await runOpenAIToolLoop({
      apiKey,
      model,
      system: req.system,
      messages: flatMessages,
      tools: req.tools,
      executeTool: req.executeTool,
      maxTokens: req.maxTokens,
      onFinalStart: req.onFinalStart,
      onTextDelta: req.onTextDelta,
      onToolCall: req.onToolCall,
    });
    return {
      provider: "openai",
      model,
      fullText: r.fullText,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      stopReason: finishToStopReason(r.finishReason),
    };
  }

  const openaiMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: req.system },
    ...flatMessages,
  ];

  const stream = await openai.chat.completions.create({
    model,
    messages: openaiMessages as any,
    max_completion_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  } as any);

  let fullText = "";
  let finishReason = "stop";
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream as any) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      req.onTextDelta(delta);
    }
    if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
      completionTokens = chunk.usage.completion_tokens ?? completionTokens;
    }
  }

  return {
    provider: "openai",
    model,
    fullText,
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    stopReason: finishToStopReason(finishReason),
  };
}

// The one entry point every caller uses. Never throws on a provider
// failure by itself -- it either returns a real result (from whichever
// provider actually answered) or throws only once BOTH primary and
// fallback have failed / fallback isn't configured, so callers can
// surface one clear error instead of guessing which provider was tried.
export async function completeWithFailover(
  supaAdmin: SupabaseClient,
  anthropicApiKey: string,
  openaiApiKey: string | undefined,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const wantsOpenAIDirectly = req.forceProvider === "openai";

  if (!wantsOpenAIDirectly) {
    const anthropicOpen = await isCircuitOpen(supaAdmin, "anthropic");
    if (!anthropicOpen) {
      // Tracks whether the Anthropic attempt already delivered real output
      // via the caller's onTextDelta/onThinkingDelta before failing partway
      // through its own stream. Those callbacks typically write straight
      // through to an outgoing HTTP response (see chat/index.ts and
      // trial-chat/index.ts) -- bytes already sent that way can't be
      // un-sent. Falling over to OpenAI after that point would enqueue a
      // second, complete reply on top of the truncated first one, so this
      // gates whether a fallback attempt is even safe to make.
      let anthropicEmittedOutput = false;
      const trackedReq: CompletionRequest = {
        ...req,
        onTextDelta: (text) => { anthropicEmittedOutput = true; req.onTextDelta(text); },
        onThinkingDelta: req.onThinkingDelta
          ? (t) => { anthropicEmittedOutput = true; req.onThinkingDelta!(t); }
          : undefined,
      };
      try {
        const result = await runAnthropic(anthropicApiKey, trackedReq);
        await recordSuccess(supaAdmin, "anthropic");
        return result;
      } catch (err) {
        console.error("llm: anthropic call failed, attempting openai fallback:", err instanceof Error ? err.message : String(err));
        await recordFailure(supaAdmin, "anthropic");
        if (anthropicEmittedOutput) {
          console.error("llm: anthropic already streamed partial output before failing -- not falling over to openai (would duplicate the reply)");
          throw err;
        }
      }
    } else {
      console.error("llm: anthropic circuit open, skipping straight to openai fallback");
    }
  }

  if (!openaiApiKey) {
    throw new Error(wantsOpenAIDirectly
      ? "OpenAI is not configured."
      : "Claude is currently unavailable and no fallback provider is configured.");
  }

  try {
    const result = await runOpenAI(openaiApiKey, req);
    await recordSuccess(supaAdmin, "openai");
    return result;
  } catch (err) {
    await recordFailure(supaAdmin, "openai");
    throw err;
  }
}
