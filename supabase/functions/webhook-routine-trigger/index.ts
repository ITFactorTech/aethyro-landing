// webhook-routine-trigger — public endpoint (verify_jwt: false; auth is the
// token itself, not a Supabase session, since callers are external systems
// with no Aethyro account: GitHub Actions, Zapier, IFTTT, a cron job
// elsewhere). Looks up routine_webhooks by ?token=, enforces a cooldown so a
// leaked/spammed token can't rack up unbounded credit charges, then invokes
// run-routines as the service role for just that one routine — same
// internal-caller path pg_cron itself uses (Authorization: Bearer
// <service-role-key>, body {routine_id}), which run-routines already
// recognizes and skips the per-user JWT lookup for.
//
// v2 (2026-11-16): the cooldown is now CLAIMED atomically. v1 read
// last_triggered_at, compared it in code, then wrote it with an unconditional
// UPDATE whose error was ignored -- so N requests arriving together all read
// the old value, all passed the check, and all ran (and billed) the routine.
// The claim is now one conditional UPDATE whose WHERE re-checks the cooldown
// (same pattern as auto-topup-charge and run-routines' scheduled claim):
// exactly one concurrent caller gets a row back and runs the routine, the
// rest get 429. Fail closed: a claim error is 503 and nothing runs.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COOLDOWN_MS      = 30_000;

// CORS locked to aethyro.com (+ preview subdomains); was a bare "*". See
// chat/index.ts v48's comment for the rationale. Real callers here (GitHub
// Actions, Zapier, IFTTT, a cron job elsewhere) are server-side and never
// gated by CORS at all -- this only tightens the case of a browser-based
// caller, which was never the intended usage anyway.
const ALLOWED_ORIGINS = ["https://aethyro.com", "https://www.aethyro.com"];
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-aethyro-landing\.[a-z0-9-]+\.workers\.dev$/;
function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

serve(async (req) => {
  const CORS = corsHeadersFor(req);
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

  // Cheap early exit for the common case (a token being hit repeatedly). This
  // read is NOT the guard -- concurrent requests all see the same old value --
  // the conditional UPDATE below is.
  const nowMs = Date.now();
  const cutoffMs = nowMs - COOLDOWN_MS;
  if (hook.last_triggered_at && new Date(hook.last_triggered_at).getTime() > cutoffMs)
    return new Response(JSON.stringify({ skipped: "cooldown" }), {
      status: 429, headers: { ...CORS, "Content-Type": "application/json" },
    });

  // Atomically claim this trigger BEFORE running anything: the WHERE re-checks
  // the cooldown inside the database, so of any number of simultaneous hits
  // only the first UPDATE matches the row (the others wait on its row lock,
  // re-evaluate the WHERE against the new last_triggered_at, and match
  // nothing). No claimed row -> no run.
  const { data: claimed, error: claimErr } = await supaAdmin
    .from("routine_webhooks")
    .update({
      last_triggered_at: new Date(nowMs).toISOString(),
      trigger_count: hook.trigger_count + 1,
    })
    .eq("id", hook.id)
    .or(`last_triggered_at.is.null,last_triggered_at.lte.${new Date(cutoffMs).toISOString()}`)
    .select("id");
  if (claimErr) {
    console.error("webhook-routine-trigger: cooldown claim failed, not running", claimErr.message);
    return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
      status: 503, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (!claimed || claimed.length === 0)
    return new Response(JSON.stringify({ skipped: "cooldown" }), {
      status: 429, headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    // invoke() reports a non-2xx from run-routines as a returned error, not a
    // throw -- log it, or a failed run leaves no trace on this side.
    const { error: runErr } = await supaAdmin.functions.invoke("run-routines", {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: { routine_id: hook.routine_id },
    });
    if (runErr) console.error("webhook-routine-trigger: run-routines returned an error", runErr.message);
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
