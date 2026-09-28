// webhook-routine-trigger — public endpoint (verify_jwt: false; auth is the
// token itself, not a Supabase session, since callers are external systems
// with no Aethyro account: GitHub Actions, Zapier, IFTTT, a cron job
// elsewhere). Looks up routine_webhooks by ?token=, enforces a cooldown so a
// leaked/spammed token can't rack up unbounded credit charges, then invokes
// run-routines as the service role for just that one routine — same
// internal-caller path pg_cron itself uses (Authorization: Bearer
// <service-role-key>, body {routine_id}), which run-routines already
// recognizes and skips the per-user JWT lookup for.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COOLDOWN_MS      = 30_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token)
    return new Response(JSON.stringify({ error: "token required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: hook, error: hookErr } = await supaAdmin
    .from("routine_webhooks")
    .select("id, routine_id, last_triggered_at, trigger_count")
    .eq("token", token)
    .single();
  if (hookErr || !hook)
    return new Response(JSON.stringify({ error: "invalid token" }), {
      status: 404, headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (
    hook.last_triggered_at &&
    new Date(hook.last_triggered_at).getTime() > Date.now() - COOLDOWN_MS
  )
    return new Response(JSON.stringify({ skipped: "cooldown" }), {
      status: 429, headers: { ...CORS, "Content-Type": "application/json" },
    });

  // Mark the attempt before firing, same concurrency-guard pattern as
  // auto-topup-charge, so two near-simultaneous hits can't both slip past
  // the cooldown check above.
  await supaAdmin.from("routine_webhooks").update({
    last_triggered_at: new Date().toISOString(),
    trigger_count: hook.trigger_count + 1,
  }).eq("id", hook.id);

  try {
    await supaAdmin.functions.invoke("run-routines", {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: { routine_id: hook.routine_id },
    });
  } catch (e) {
    // Don't leak internal failure detail to an external caller; the
    // routine's own last_result (visible in-app to its owner) carries the
    // real error if run-routines itself failed.
    console.error("webhook-routine-trigger: run-routines invoke failed", (e as Error).message);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
