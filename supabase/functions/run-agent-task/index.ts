// run-agent-task v1 — Long-horizon agentic task runner
// Plans a goal into steps, executes each with tool use, stores progress in DB.
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

const PLANNER_MODEL  = "claude-haiku-4-5-20251001";
const EXECUTOR_MODEL_MAP: Record<string, string> = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus:   "claude-opus-5-5",
};
const CREDIT_RATES: Record<string, { input: number; output: number }> = {
  haiku:  { input: 0.08,  output: 0.40  },
  sonnet: { input: 0.30,  output: 1.50  },
  opus:   { input: 1.50,  output: 7.50  },
};
const MAX_STEPS      = 6;
const STEP_MAX_TOOLS = 3;
const STEP_MAX_TOK   = 2048;

// ── Web search tool ───────────────────────────────────────────────────────────

async function webSearch(query: string): Promise<string> {
  if (!TAVILY_API_KEY) return "Web search unavailable.";
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: 5,
        include_answer: true,
        search_depth: "advanced",
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return `Search error (${r.status})`;
    const d = await r.json();
    let out = d.answer ? `Summary: ${d.answer}\n\n` : "";
    if (d.results?.length) {
      out += d.results.slice(0, 5).map((x: any, i: number) =>
        `${i + 1}. ${x.title}\n   ${(x.content || "").slice(0, 500)}`
      ).join("\n\n");
    }
    return out.slice(0, 8000) || "No results.";
  } catch {
    return "Search timed out.";
  }
}

const AGENT_TOOLS: Anthropic.Tool[] = [
  ...(TAVILY_API_KEY ? [{
    name: "web_search" as const,
    description: "Search the web for current information. Use for facts, news, research, data.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  }] : []),
  {
    name: "synthesize",
    description: "Produce a final answer or report from gathered information. Call this to conclude the task.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short title for the result" },
        content: { type: "string", description: "Full result / answer / report in markdown" },
      },
      required: ["title", "content"],
    },
  },
];

// ── Execute one step ──────────────────────────────────────────────────────────

async function executeStep(
  anthropic: Anthropic,
  goal: string,
  stepDesc: string,
  stepContext: string,
  modelKey: string,
): Promise<{ result: string; toolCalls: any[]; done: boolean }> {
  const model = EXECUTOR_MODEL_MAP[modelKey] || EXECUTOR_MODEL_MAP.haiku;
  const messages: Anthropic.MessageParam[] = [{
    role: "user",
    content: `You are executing step "${stepDesc}" as part of the larger goal: "${goal}"\n\nContext so far:\n${stepContext}\n\nComplete this step. Use tools if needed. When you have enough information to fully answer the goal, call the synthesize tool.`,
  }];

  let toolCalls: any[] = [];
  let result = "";
  let done = false;

  for (let round = 0; round < STEP_MAX_TOOLS; round++) {
    const r = await anthropic.messages.create({
      model,
      max_tokens: STEP_MAX_TOK,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: { type: "auto" },
    });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const blk of r.content) {
      if (blk.type !== "tool_use") continue;
      let toolResult = "";
      if (blk.name === "web_search") {
        toolResult = await webSearch((blk.input as any).query || "");
        toolCalls.push({ tool: "web_search", query: (blk.input as any).query });
      } else if (blk.name === "synthesize") {
        result = `**${(blk.input as any).title}**\n\n${(blk.input as any).content}`;
        done = true;
        toolResult = "Synthesis complete.";
        toolCalls.push({ tool: "synthesize" });
      }
      toolResults.push({ type: "tool_result", tool_use_id: blk.id, content: toolResult });
    }

    if (r.stop_reason !== "tool_use" || done) {
      if (!result) {
        result = r.content
          .filter(b => b.type === "text")
          .map(b => (b as any).text)
          .join("") || "Step completed.";
      }
      break;
    }

    messages.push(
      { role: "assistant", content: r.content },
      { role: "user", content: toolResults },
    );
  }

  return { result, toolCalls, done };
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

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const goal: string = (body.goal || "").trim();
  const modelKey = ["haiku", "sonnet", "opus"].includes(body.model) ? body.model : "sonnet";
  const rates = CREDIT_RATES[modelKey];

  if (!goal)
    return new Response(JSON.stringify({ error: "goal required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Credit check (tasks use at least 50 credits minimum estimate)
  const { data: balance } = await supaAdmin.rpc("get_credit_balance", { p_user_id: user.id });
  if (typeof balance === "number" && balance < 50)
    return new Response(JSON.stringify({ error: "Insufficient credits for agent task (need ≥ 50)" }), {
      status: 402, headers: { ...CORS, "Content-Type": "application/json" },
    });

  // Create task record
  const { data: task, error: taskErr } = await supaAdmin
    .from("agent_tasks")
    .insert({ user_id: user.id, goal, status: "running" })
    .select("id")
    .single();
  if (taskErr)
    return new Response(JSON.stringify({ error: taskErr.message }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const taskId = task.id;
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let totalInput = 0, totalOutput = 0;

  // ── Planning phase ────────────────────────────────────────────────────────
  let plan: string[] = [];
  try {
    const planRes = await anthropic.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Break down this goal into ${MAX_STEPS} or fewer concrete, actionable steps. Return ONLY a JSON array of step descriptions, no explanation.\n\nGoal: ${goal}`,
      }],
    });
    totalInput += planRes.usage.input_tokens;
    totalOutput += planRes.usage.output_tokens;
    const raw = planRes.content.find(b => b.type === "text") as any;
    const match = (raw?.text || "").match(/\[[\s\S]*\]/);
    if (match) plan = JSON.parse(match[0]).slice(0, MAX_STEPS);
  } catch {}

  if (!plan.length) plan = ["Research the topic", "Analyze findings", "Synthesize and report"];

  // Store plan
  await supaAdmin.from("agent_tasks").update({ plan: { steps: plan } }).eq("id", taskId);

  // Insert step records
  await supaAdmin.from("agent_task_steps").insert(
    plan.map((desc, i) => ({ task_id: taskId, step_index: i, description: desc }))
  );

  // ── Execution phase ───────────────────────────────────────────────────────
  let stepContext = `Goal: ${goal}\n\n`;
  let finalResult = "";
  let taskFailed = false;

  for (let i = 0; i < plan.length; i++) {
    const stepDesc = plan[i];

    // Mark step running
    await supaAdmin.from("agent_task_steps")
      .update({ status: "running" })
      .eq("task_id", taskId).eq("step_index", i);

    try {
      const { result, toolCalls, done } = await executeStep(
        anthropic, goal, stepDesc, stepContext, modelKey
      );

      stepContext += `\nStep ${i + 1} (${stepDesc}):\n${result}\n`;

      await supaAdmin.from("agent_task_steps").update({
        status: "completed",
        result: result.slice(0, 4000),
        tool_calls: toolCalls,
      }).eq("task_id", taskId).eq("step_index", i);

      if (done) {
        finalResult = result;
        // Mark remaining steps skipped
        await supaAdmin.from("agent_task_steps")
          .update({ status: "skipped" })
          .eq("task_id", taskId)
          .gt("step_index", i);
        break;
      }
    } catch (e) {
      await supaAdmin.from("agent_task_steps").update({
        status: "failed",
        result: `Error: ${(e as Error).message}`,
      }).eq("task_id", taskId).eq("step_index", i);
      taskFailed = true;
      break;
    }
  }

  // ── Final synthesis if not already done ───────────────────────────────────
  if (!finalResult && !taskFailed) {
    try {
      const synthRes = await anthropic.messages.create({
        model: EXECUTOR_MODEL_MAP[modelKey],
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: `You completed research for this goal: "${goal}"\n\nWork done:\n${stepContext}\n\nWrite a comprehensive final answer/report in markdown. Be thorough and well-structured.`,
        }],
      });
      totalInput += synthRes.usage.input_tokens;
      totalOutput += synthRes.usage.output_tokens;
      finalResult = (synthRes.content.find(b => b.type === "text") as any)?.text || "Task complete.";
    } catch {}
  }

  // ── Billing ───────────────────────────────────────────────────────────────
  const cost = Math.max(
    10,
    Math.ceil((totalInput / 1000) * rates.input + (totalOutput / 1000) * rates.output)
  );
  await supaAdmin.from("credit_ledger").insert({
    user_id: user.id, delta: -cost, reason: "agent_task",
  });

  // ── Finalize task ─────────────────────────────────────────────────────────
  await supaAdmin.from("agent_tasks").update({
    status: taskFailed ? "failed" : "completed",
    result: finalResult.slice(0, 20000),
    credits_used: cost,
    updated_at: new Date().toISOString(),
  }).eq("id", taskId);

  const { data: newBal } = await supaAdmin.rpc("get_credit_balance", { p_user_id: user.id });

  return new Response(JSON.stringify({
    task_id: taskId,
    status: taskFailed ? "failed" : "completed",
    result: finalResult,
    credits_used: cost,
    balance: newBal,
  }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
