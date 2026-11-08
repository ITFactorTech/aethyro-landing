// OpenAI tool-calling loop (Responses API), used by _shared/llm.ts when a
// caller passes `tools`. Tool definitions arrive in Anthropic's shape
// ({ name, description, input_schema }) because that is what chat/index.ts
// already builds for Claude; they are converted to OpenAI function tools
// here, so ONE tool registry and ONE executor serve both providers.
//
// Why the Responses API and not Chat Completions: probed live 2026-11-08,
// gpt-6.1-sol rejects function tools on /v1/chat/completions at every
// reasoning effort ("Function tools with reasoning_effort are not supported
// ... use /v1/responses"), and it also rejects reasoning_effort "none"
// (supported: low/medium/high/xhigh). So tools + reasoning needs /v1/responses.
// Stateless on purpose (store:false): nothing is retained for later retrieval;
// reasoning items are replayed between rounds via encrypted_content.
//
// Mirrors the Claude tool loop in chat/index.ts on purpose:
//  - up to `maxRounds` tool rounds, then one final call with tool_choice
//    "none" so a budget-exhausted loop still produces a written answer
//    (the Claude loop's equivalent is its final no-tools stream);
//  - tool calls run sequentially, capped per round;
//  - text from a round that ends in tool calls is NOT shown (same as the
//    Claude path, which only enqueues the final round's text);
//  - the executor never throws into the loop -- it returns an error string,
//    which the model sees as the tool result.
//
// Streaming: a round is streamed from OpenAI, but its text is held back
// until we know it is the final answer. Once a round has produced
// COMMIT_CHARS of text with no tool call seen, it is treated as final: the
// caller's onFinalStart() fires (chat uses it to emit the tool-card prefix,
// which must precede any answer text) and the rest streams live. A tool call
// that still arrives after that point (a long preface before a call) is
// executed normally; only the tool *cards* for it can't be shown, because
// the prefix is already sent.

export interface ToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface ToolLoopOptions {
  apiKey: string;
  model: string;
  system: string;
  // Plain-text conversation (already flattened by the caller); no system turn.
  messages: { role: "user" | "assistant"; content: string }[];
  tools: ToolDef[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxTokens: number;           // max_output_tokens per round (includes reasoning tokens)
  maxRounds?: number;          // tool rounds before the forced-text final call (default 4)
  maxCallsPerRound?: number;   // extra calls in one round get a "skipped" result (default 4)
  reasoningEffort?: string;    // default "low": tool turns favour latency and cost
  onFinalStart?: () => void;   // fires once, just before the first answer text is emitted
  // Checked after each round's tools have run; true ends the loop right there
  // (run-agent-task's `synthesize` tool: calling it IS the answer).
  stopWhen?: () => boolean;
  onTextDelta: (text: string) => void;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
}

export interface ToolLoopResult {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  // Chat-Completions vocabulary so llm.ts's stop-reason mapping is shared:
  // "stop" | "length" (hit max_output_tokens) | "content_filter".
  finishReason: string;
  rounds: number;              // API calls made
  toolCalls: number;           // tool calls executed
}

const COMMIT_CHARS = 40;
const MAX_TOOL_RESULT_CHARS = 12000;

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* ignore a malformed/keep-alive frame */ }
    }
  }
}

export async function runOpenAIToolLoop(o: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxRounds = o.maxRounds ?? 4;
  const maxCalls = o.maxCallsPerRound ?? 4;
  const known = new Set(o.tools.map((t) => t.name));
  const oaTools = o.tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema,
  }));

  const input: any[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let finishReason = "stop";
  let finalStarted = false;

  const emit = (t: string) => {
    if (!t) return;
    if (!finalStarted) { finalStarted = true; o.onFinalStart?.(); }
    fullText += t;
    o.onTextDelta(t);
  };

  for (let round = 0; round <= maxRounds; round++) {
    const forceText = round === maxRounds; // tool budget used up: answer now
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: o.model,
        instructions: o.system,
        input,
        // An empty tool list makes this a plain (tool-free) completion, which
        // the background jobs also use for planning/synthesis calls.
        ...(oaTools.length > 0 ? { tools: oaTools, tool_choice: forceText ? "none" : "auto" } : {}),
        reasoning: { effort: o.reasoningEffort ?? "low" },
        max_output_tokens: o.maxTokens,
        store: false,
        include: ["reasoning.encrypted_content"],
        stream: true,
      }),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`OpenAI ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
    }

    let roundText = "";
    let held = "";
    let committed = false;
    let sawToolCall = false;
    let completed: any = null;
    // Separate this round's answer from text already shown in an earlier one.
    const sep = () => (fullText && !/\s$/.test(fullText) ? "\n\n" : "");

    for await (const ev of sseEvents(resp.body)) {
      if (ev.type === "response.output_text.delta" || ev.type === "response.refusal.delta") {
        const d: string = ev.delta ?? "";
        if (!d) continue;
        roundText += d;
        if (committed) {
          emit(d);
        } else {
          held += d;
          if (!sawToolCall && held.length >= COMMIT_CHARS) {
            committed = true;
            emit(sep() + held);
            held = "";
          }
        }
      } else if (ev.type === "response.output_item.added") {
        if (ev.item?.type === "function_call") sawToolCall = true;
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        completed = ev.response;
      } else if (ev.type === "response.failed") {
        throw new Error(ev.response?.error?.message || "OpenAI response failed");
      } else if (ev.type === "error") {
        throw new Error(ev.message || "OpenAI stream error");
      }
    }
    if (!completed) throw new Error("OpenAI stream ended without a completed response");

    inputTokens += completed.usage?.input_tokens ?? 0;
    outputTokens += completed.usage?.output_tokens ?? 0;
    finishReason = completed.status === "incomplete"
      ? (completed.incomplete_details?.reason === "content_filter" ? "content_filter" : "length")
      : "stop";

    const output: any[] = completed.output ?? [];
    const pending = output.filter((it) => it?.type === "function_call");

    if (forceText || pending.length === 0) {
      // Final answer: flush anything still held back.
      if (!committed && held) emit(sep() + held);
      return { fullText, inputTokens, outputTokens, finishReason, rounds: round + 1, toolCalls };
    }

    // Tool round: held text (a preface) is dropped from the visible reply but
    // stays in the conversation the model sees (output items are replayed).
    input.push(...output);

    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      let result: string;
      if (i >= maxCalls) {
        result = "Skipped: too many tool calls at once. Ask for fewer, or answer from what you have.";
      } else if (!known.has(c.name)) {
        result = `Unknown tool "${c.name}".`;
      } else {
        let args: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(c.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        } catch { /* falls through to the error result */ }
        if (!args) {
          result = "Invalid tool arguments (expected a JSON object).";
        } else {
          o.onToolCall?.(c.name, args);
          toolCalls++;
          result = await o.executeTool(c.name, args);
        }
      }
      input.push({ type: "function_call_output", call_id: c.call_id, output: String(result).slice(0, MAX_TOOL_RESULT_CHARS) });
    }
    if (o.stopWhen?.()) {
      return { fullText, inputTokens, outputTokens, finishReason, rounds: round + 1, toolCalls };
    }
  }

  // Unreachable: the forceText round always returns above.
  return { fullText, inputTokens, outputTokens, finishReason, rounds: maxRounds + 1, toolCalls };
}
