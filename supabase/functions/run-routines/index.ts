// run-routines v5 — real web_search tool access, closing a real customer
// -impact bug `growth` found 2026-11-02 (CLAUDE.md Pending, PR #206): this
// function had zero tool access at all, unlike chat/index.ts's proven
// Tavily-backed web_search -- a "Daily Briefing"-shaped routine prompt
// reliably produced stale/recycled "news" dressed up as current, because
// the model had no live data source and just pattern-completed from
// training. Mirrors chat's tool shape deliberately closely (same Tavily
// /search endpoint, same api_key-in-body auth -- NOT a Bearer header,
// which this project's Tavily key rejects for /search specifically -- see
// CLAUDE.md's TAVILY_API_KEY history), gated on TAVILY_API_KEY same as
// chat. Scoped to web_search only -- no fetch_url/crawl_site/GitHub/
// Notion: this function has no per-user integration-token plumbing the
// way chat does, and the one real bug this closes only ever needed
// current web results, not page-reading or crawling. The tool is offered
// unconditionally on every routine (same as chat always offering
// web_search when TAVILY_API_KEY is set) rather than only on prompts that
// look news-dependent -- simpler, and the model itself decides whether to
// actually call it via tool_choice:"auto", so a routine that doesn't need
// search just never calls it (verified live, see CLAUDE.md). Billing is
// unaffected structurally: cost was already computed from real
// msg.usage.input_tokens/output_tokens (never a hardcoded flat rate,
// despite landing on the 1-credit floor for every real routine run so
// far) -- a tool round's extra tokens are now summed across every
// Anthropic call in the loop before the cost formula runs, so a
// search-using routine is billed for the real extra tokens it consumes,
// not silently undercharged.
// run-routines v4 — visible missed-run history + a real notification on
// skip, closing the trust gap real pre-launch feedback flagged: an
// empty-balance skip previously only overwrote last_result with a
// one-line note nobody saw unless they opened the app, with zero
// notification and no way to tell "ran fine 10 times, skipped once" from
// "has never worked." Every attempt (completed/skipped_no_credits/error)
// now also writes a row to the new routine_run_log table (see its own
// migration) so the UI can show real history, not just the latest
// last_result. On a credit skip specifically, if the routine has
// email_on_result = true, send-routine-result-email now also fires with
// skipped:true -- the same opt-in a user already set to hear about
// results now also tells them when a run didn't happen and why.
// run-routines v3 — the return-visit hook: after a successful run, if the
// routine has email_on_result = true, invokes send-routine-result-email so
// the owner gets a short summary instead of the result sitting silently
// in the Routines tab. Also: this file's own "Invoked by pg_cron every 15
// minutes" claim below was false until 2026-10-06 -- no pg_cron job ever
// actually called this function (confirmed live via `select * from
// cron.job`, which listed 5 jobs, none targeting run-routines), meaning
// every routine in this product could only ever run via a manual "Run
// now" click, a webhook trigger, or a routine chain, never on its own
// schedule. Fixed with migration 20261006020100_schedule_run_routines_cron.sql.
// v2 — Scheduled agent routine executor
// Invoked by pg_cron every 15 minutes (or manually from the dashboard/frontend).
// Queries user_routines where enabled=true and next_run_at <= now(),
// runs each routine with Claude, stores result, advances next_run_at.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.24.3?target=deno";

// CORS locked to aethyro.com (+ preview subdomains); was a bare "*". See
// chat/index.ts v48's comment for the rationale.
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
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TAVILY_API_KEY    = Deno.env.get("TAVILY_API_KEY");

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

// ── Web search (mirrors chat/index.ts's executeWebSearch exactly) ──────────
// Tavily's /search endpoint, api_key in the JSON body -- NOT a Bearer
// header, which this project's Tavily key rejects for /search specifically
// (confirmed live, see CLAUDE.md's TAVILY_API_KEY history). Copied
// deliberately close to verbatim from the proven chat implementation
// rather than re-derived from Tavily's docs.
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

// Offered on every routine when TAVILY_API_KEY is set, same as chat always
// offering web_search regardless of message content -- the model decides
// whether to actually call it via tool_choice:"auto", so a routine whose
// prompt doesn't need current info just never invokes it (verified live,
// see CLAUDE.md). Scoped to web_search only -- see this file's v5 header
// comment for why fetch_url/crawl_site/GitHub/Notion aren't included here.
const TOOLS: Anthropic.Tool[] = TAVILY_API_KEY
  ? [{
      name: "web_search",
      description: "Search the web for current, up-to-date information. Use proactively for questions about recent news, events, prices, scores, weather, release dates, or anything else where real documented data beats general reasoning. Answer from knowledge for timeless facts.",
      input_schema: {
        type: "object" as const,
        properties: { query: { type: "string", description: "Concise, specific search query" } },
        required: ["query"],
      },
    }]
  : [];
const MAX_TOOL_ROUNDS = 4;

// Runs one routine's completion, looping through tool-use rounds (if
// TOOLS is non-empty) exactly like chat's generateCompletion: the model
// requests web_search, this calls Tavily, feeds the result back, and the
// loop continues until the model produces a final text reply or
// MAX_TOOL_ROUNDS is exhausted (in which case one last call, with no
// tools, forces a text answer). Token usage is accumulated across every
// call in the loop so the caller's cost computation reflects the real
// total, including any tool round(s).
async function runRoutineCompletion(
  anthropic: Anthropic,
  model: string,
  promptText: string,
): Promise<{ resultText: string; inputTokens: number; outputTokens: number }> {
  let inputTokens = 0;
  let outputTokens = 0;
  let messages: any[] = [{ role: "user", content: promptText }];
  const system = "You are Aethyro, a scheduled AI assistant. Produce a concise, useful result for the user's routine task. Use markdown. Be direct and actionable.";

  if (TOOLS.length > 0) {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const r = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        system,
        messages,
        tools: TOOLS,
        tool_choice: { type: "auto" },
      });
      inputTokens += r.usage.input_tokens;
      outputTokens += r.usage.output_tokens;

      if (r.stop_reason !== "tool_use") {
        const resultBlock = r.content.find((b) => b.type === "text") as any;
        return { resultText: resultBlock?.text || "Routine completed.", inputTokens, outputTokens };
      }

      const toolResults: any[] = [];
      for (const blk of r.content) {
        if (blk.type !== "tool_use") continue;
        let result = "Tool execution failed or not supported.";
        try {
          if (blk.name === "web_search") {
            result = await executeWebSearch((blk.input as any).query || "");
          }
        } catch (e) {
          result = `Tool error: ${(e as Error).message}`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: blk.id, content: result });
      }

      messages = [...messages, { role: "assistant", content: r.content }, { role: "user", content: toolResults }];
    }
  }

  // No tools configured, or MAX_TOOL_ROUNDS exhausted still requesting a
  // tool: one final call with no tools forces a text reply, same fallback
  // shape as chat's own tool loop.
  const final = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    system,
    messages,
  });
  inputTokens += final.usage.input_tokens;
  outputTokens += final.usage.output_tokens;
  const resultBlock = final.content.find((b) => b.type === "text") as any;
  return { resultText: resultBlock?.text || "Routine completed.", inputTokens, outputTokens };
}

// Chained routines re-invoke this function internally after each successful
// step (same Authorization: Bearer <service-role-key> pattern webhook-routine-
// trigger already uses). This caps how many hops a single external trigger
// can cause — the DB's own trg_enforce_routine_chain already rejects a true
// cycle at write time, this is just a runtime backstop against anything that
// slips past it (or a long legitimate chain looping credits away).
const MAX_CHAIN_DEPTH = 5;

// ── cron-expression → next Date ──────────────────────────────────────────────
// Minimal 5-field cron parser: minute hour dom month dow
// Returns next firing time at least 1 minute from now.
function nextCronDate(expr: string, from: Date = new Date()): Date {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return new Date(from.getTime() + 3_600_000);
  }
  const [minPart, hourPart, domPart, monPart, dowPart] = parts;

  function matches(val: number, part: string): boolean {
    if (part === "*") return true;
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2));
      return val % step === 0;
    }
    return part.split(",").some(p => {
      const [a, b] = p.split("-").map(Number);
      return b !== undefined ? val >= a && val <= b : val === a;
    });
  }

  const candidate = new Date(from.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  for (let m = 0; m < 525_960; m++) {
    if (
      matches(candidate.getUTCMinutes(), minPart) &&
      matches(candidate.getUTCHours(), hourPart) &&
      matches(candidate.getUTCDate(), domPart) &&
      matches(candidate.getUTCMonth() + 1, monPart) &&
      matches(candidate.getUTCDay(), dowPart)
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return new Date(from.getTime() + 3_600_000);
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/, "");

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // If user JWT (not the service-role key): only run that user's due routines
  let userFilter: string | null = null;
  if (jwt && jwt !== SERVICE_ROLE_KEY) {
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user } } = await supaUser.auth.getUser();
    if (user) userFilter = user.id;
  }

  // Parse optional body for single routine trigger / chained-step context
  let singleRoutineId: string | null = null;
  let chainContext: string | null = null;
  let chainDepth = 0;
  try {
    const body = await req.json();
    singleRoutineId = body?.routine_id || null;
    chainContext = typeof body?.chain_context === "string" ? body.chain_context : null;
    chainDepth = Number.isInteger(body?.chain_depth) ? body.chain_depth : 0;
  } catch { /* no body or non-JSON from pg_cron — fine */ }

  // Fetch due routines
  // When running a specific routine on demand, skip the schedule filter.
  let query = supaAdmin
    .from("user_routines")
    .select("*")
    .eq("enabled", true);

  if (!singleRoutineId) {
    query = query.or(`next_run_at.is.null,next_run_at.lte.${new Date().toISOString()}`);
  }

  if (userFilter)      query = query.eq("user_id", userFilter);
  if (singleRoutineId) query = query.eq("id", singleRoutineId);

  const { data: routines, error } = await query;
  if (error || !routines?.length) {
    return new Response(JSON.stringify({ ran: 0 }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const results: { id: string; name: string; status: string }[] = [];

  for (const routine of routines) {
    const modelKey = ["haiku", "sonnet", "opus"].includes(routine.model) ? routine.model : "haiku";
    const model = MODEL_MAP[modelKey];
    const rates = CREDIT_RATES[modelKey];

    try {
      // Credit check — treat null balance (new user, no ledger rows) as 0
      const { data: rawBalance, error: balanceErr } = await supaAdmin.rpc("get_credit_balance", {
        p_user_id: routine.user_id,
      });
      const { data: routineProfile, error: profileErr } = await supaAdmin
        .from("profiles").select("team_id, monthly_spend_cap_credits").eq("id", routine.user_id).single();
      // Fail closed (2026-11-06): get_credit_balance() coalesces to 0, so an
      // error or non-number means the preflight failed -- never run the
      // routine, and never mislabel it "skipped_no_credits". Throwing lands in
      // the per-routine catch below, which records status 'error' (this slot is
      // missed and visible in routine_run_log, not silently run unbilled).
      if (balanceErr || profileErr || !routineProfile || typeof rawBalance !== "number") {
        throw new Error(`Billing preflight failed: ${balanceErr?.message ?? profileErr?.message ?? "invalid state"}`);
      }
      const balance = rawBalance;
      // Monthly spend cap (opt-in, NULL = off): skip like a no-credits run,
      // with its own status so it is distinguishable in routine_run_log.
      if (typeof routineProfile?.monthly_spend_cap_credits === "number") {
        const { data: spentSoFar, error: spendErr } = await supaAdmin.rpc("get_monthly_spend", { p_user_id: routine.user_id });
        if (spendErr || typeof spentSoFar !== "number") {
          throw new Error(`Billing preflight failed: ${spendErr?.message ?? "non-numeric monthly spend"}`);
        }
        const spent = spentSoFar;
        if (spent >= routineProfile.monthly_spend_cap_credits) {
          await supaAdmin.from("user_routines").update({
            last_run_at:  new Date().toISOString(),
            next_run_at:  nextCronDate(routine.schedule).toISOString(),
            last_result:  `⚠️ Skipped — monthly spend cap reached (${spent} of ${routineProfile.monthly_spend_cap_credits} credits this month).`,
          }).eq("id", routine.id);
          const { error: capLogErr } = await supaAdmin.from("routine_run_log").insert({
            routine_id: routine.id,
            user_id:    routine.user_id,
            status:     "skipped_monthly_cap",
            detail:     "Monthly spend cap reached",
          });
          if (capLogErr) console.error("run-routines: routine_run_log insert failed", capLogErr.message);
          results.push({ id: routine.id, name: routine.name, status: "skipped_monthly_cap" });
          continue;
        }
      }
      if (balance <= 0) {
        await supaAdmin.from("user_routines").update({
          last_run_at:  new Date().toISOString(),
          next_run_at:  nextCronDate(routine.schedule).toISOString(),
          last_result:  "⚠️ Skipped — no credits.",
        }).eq("id", routine.id);
        const { error: logErr } = await supaAdmin.from("routine_run_log").insert({
          routine_id: routine.id,
          user_id:    routine.user_id,
          status:     "skipped_no_credits",
          detail:     "No credits remaining",
        });
        if (logErr) console.error("run-routines: routine_run_log insert failed", logErr.message);
        // Same opt-in that gets you a result email now also tells you when
        // a run didn't happen and why -- previously this was a fully silent
        // skip with no notification of any kind.
        if (routine.email_on_result) {
          try {
            await supaAdmin.functions.invoke("send-routine-result-email", {
              headers: { "X-Internal-Key": SERVICE_ROLE_KEY },
              body: { user_id: routine.user_id, routine_name: routine.name, skipped: true, reason: "no_credits" },
            });
          } catch (emailErr) {
            console.error("run-routines: skip-notification invoke failed", (emailErr as Error).message);
          }
        }
        results.push({ id: routine.id, name: routine.name, status: "skipped_no_credits" });
        continue;
      }

      // Run the routine prompt — when this run is a chained step, prepend
      // the previous routine's output so the model can build on it instead
      // of starting cold.
      const promptText = chainContext
        ? `Context from the previous step in this routine chain:\n${chainContext}\n\n---\n\nYour task:\n${routine.prompt}`
        : routine.prompt;

      const { resultText, inputTokens, outputTokens } = await runRoutineCompletion(anthropic, model, promptText);

      // Bill credits -- summed across every Anthropic call this run made
      // (including any tool round), not just a single call's usage, so a
      // search-using routine is billed for the real extra tokens it
      // consumed.
      const cost = Math.max(
        1,
        Math.ceil(
          (inputTokens  / 1000) * rates.input +
          (outputTokens / 1000) * rates.output,
        ),
      );
      const { error: ledgerErr } = await supaAdmin.from("credit_ledger").insert({
        user_id: routine.user_id,
        delta:   -cost,
        reason:  "routine",
        team_id: routineProfile?.team_id ?? null,
      });
      if (ledgerErr) console.error("routine credit_ledger insert failed", ledgerErr.message);

      // Advance routine schedule
      await supaAdmin.from("user_routines").update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextCronDate(routine.schedule).toISOString(),
        last_result: resultText.slice(0, 10000),
      }).eq("id", routine.id);

      const { error: logErr } = await supaAdmin.from("routine_run_log").insert({
        routine_id: routine.id,
        user_id:    routine.user_id,
        status:     "completed",
        detail:     resultText.slice(0, 500),
      });
      if (logErr) console.error("run-routines: routine_run_log insert failed", logErr.message);

      results.push({ id: routine.id, name: routine.name, status: "completed" });

      // Return-visit hook: email the owner a short summary of this result
      // if they've opted in. Awaited (not fire-and-forget) for the same
      // reason the chained-step invoke below is -- this isolate must not
      // get frozen/recycled mid-call. Never blocks the routine's own
      // success on an email failure.
      if (routine.email_on_result) {
        try {
          await supaAdmin.functions.invoke("send-routine-result-email", {
            headers: { "X-Internal-Key": SERVICE_ROLE_KEY },
            body: { user_id: routine.user_id, routine_name: routine.name, result_text: resultText },
          });
        } catch (emailErr) {
          console.error("run-routines: send-routine-result-email invoke failed", (emailErr as Error).message);
        }
      }

      // Chained next step: hand this routine's output to the next one as
      // context and run it immediately, rather than waiting for its own
      // schedule. Awaited (not fire-and-forget) so billing/results for the
      // whole chain land before this HTTP response returns, and so this
      // isolate doesn't get frozen/recycled mid-chain the way an
      // un-awaited background call risked (see CLAUDE.md's
      // EdgeRuntime.waitUntil() note). Depth-capped independently of the
      // DB's own cycle-detection trigger, which only guards against a true
      // cycle at write time, not a long legitimate chain.
      if (routine.next_routine_id && chainDepth < MAX_CHAIN_DEPTH - 1) {
        try {
          await supaAdmin.functions.invoke("run-routines", {
            headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
            body: {
              routine_id: routine.next_routine_id,
              chain_context: resultText,
              chain_depth: chainDepth + 1,
            },
          });
        } catch (chainErr) {
          console.error("run-routines: chained step invoke failed", (chainErr as Error).message);
        }
      }
    } catch (e) {
      await supaAdmin.from("user_routines").update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextCronDate(routine.schedule).toISOString(),
        last_result: `Error: ${(e as Error).message}`,
      }).eq("id", routine.id);
      const { error: logErr } = await supaAdmin.from("routine_run_log").insert({
        routine_id: routine.id,
        user_id:    routine.user_id,
        status:     "error",
        detail:     (e as Error).message.slice(0, 500),
      });
      if (logErr) console.error("run-routines: routine_run_log insert failed", logErr.message);
      results.push({ id: routine.id, name: routine.name, status: "error" });
    }
  }

  return new Response(JSON.stringify({ ran: results.length, results }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
