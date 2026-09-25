// run-routines v2 — Scheduled agent routine executor
// Invoked by pg_cron every 15 minutes (or manually from the dashboard/frontend).
// Queries user_routines where enabled=true and next_run_at <= now(),
// runs each routine with Claude, stores result, advances next_run_at.
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

  // Parse optional body for single routine trigger
  let singleRoutineId: string | null = null;
  try {
    const body = await req.json();
    singleRoutineId = body?.routine_id || null;
  } catch { /* no body or non-JSON from pg_cron — fine */ }

  // Fetch due routines
  let query = supaAdmin
    .from("user_routines")
    .select("*")
    .eq("enabled", true)
    .or(`next_run_at.is.null,next_run_at.lte.${new Date().toISOString()}`);

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

      // Run the routine prompt
      const msg = await anthropic.messages.create({
        model,
        max_tokens: 1500,
        system: "You are Aethyro, a scheduled AI assistant. Produce a concise, useful result for the user's routine task. Use markdown. Be direct and actionable.",
        messages: [{ role: "user", content: routine.prompt }],
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
      await supaAdmin.from("credit_ledger").insert({
        user_id: routine.user_id,
        delta:   -cost,
        reason:  "routine",
      });

      // Advance routine schedule
      await supaAdmin.from("user_routines").update({
        last_run_at: new Date().toISOString(),
        next_run_at: nextCronDate(routine.schedule).toISOString(),
        last_result: resultText.slice(0, 10000),
      }).eq("id", routine.id);

      results.push({ id: routine.id, name: routine.name, status: "completed" });
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
