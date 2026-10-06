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
      const { data: rawBalance } = await supaAdmin.rpc("get_credit_balance", {
        p_user_id: routine.user_id,
      });
      const { data: routineProfile } = await supaAdmin
        .from("profiles").select("team_id").eq("id", routine.user_id).single();
      const balance = typeof rawBalance === "number" ? rawBalance : 0;
      if (balance <= 0) {
        await supaAdmin.from("user_routines").update({
          last_run_at:  new Date().toISOString(),
          next_run_at:  nextCronDate(routine.schedule).toISOString(),
          last_result:  "⚠️ Skipped — no credits.",
        }).eq("id", routine.id);
        results.push({ id: routine.id, name: routine.name, status: "skipped_no_credits" });
        continue;
      }

      // Run the routine prompt — when this run is a chained step, prepend
      // the previous routine's output so the model can build on it instead
      // of starting cold.
      const promptText = chainContext
        ? `Context from the previous step in this routine chain:\n${chainContext}\n\n---\n\nYour task:\n${routine.prompt}`
        : routine.prompt;

      const msg = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        system: "You are Aethyro, a scheduled AI assistant. Produce a concise, useful result for the user's routine task. Use markdown. Be direct and actionable.",
        messages: [{ role: "user", content: promptText }],
      });

      const resultBlock = msg.content.find(b => b.type === "text") as any;
      const resultText = resultBlock?.text || "Routine completed.";

      // Bill credits
      const cost = Math.max(
        1,
        Math.ceil(
          (msg.usage.input_tokens  / 1000) * rates.input +
          (msg.usage.output_tokens / 1000) * rates.output,
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
      results.push({ id: routine.id, name: routine.name, status: "error" });
    }
  }

  return new Response(JSON.stringify({ ran: results.length, results }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
