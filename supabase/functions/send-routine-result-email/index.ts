// send-routine-result-email v2 — adds a skipped:true branch: run-routines
// now also calls this when a scheduled run is skipped for lack of credits
// (previously a fully silent skip, see run-routines v4's own comment) --
// same email_on_result opt-in, a different subject/body/CTA (buy credits,
// not "open Aethyro") so the two cases read as clearly different things.
// send-routine-result-email v1 — the return-visit hook: run-routines calls
// this right after a routine's scheduled/webhook/chained/manual run
// completes successfully, if that routine has email_on_result = true, so
// a result produced while the user wasn't looking at the app is still a
// reason to come back, instead of sitting silently in the Routines tab
// until they happen to open it. Same internal-auth pattern as
// send-low-credit-email (X-Internal-Key, not a Supabase session JWT,
// since the caller is run-routines' own service-role client, never a
// real user).
// CORS locked to aethyro.com (+ preview subdomains); was a bare "*" on the
// OPTIONS preflight. See chat/index.ts v48's comment for the rationale.
// This function's actual data responses never carried CORS headers at
// all (internal-only, auth'd via X-Internal-Key, never called from a
// browser), so this only tightens the OPTIONS preflight, not a real gap.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const ALLOWED_ORIGINS = ["https://aethyro.com", "https://www.aethyro.com"];
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-aethyro-landing\.[a-z0-9-]+\.workers\.dev$/;
function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type, x-internal-key",
    "Vary": "Origin",
  };
}

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM = "Aethyro <hello@aethyro.com>";
const CHAT_URL = "https://aethyro.com/app/chat.html";
const BUY_URL = "https://aethyro.com/#pricing"; // never a bare Stripe link, see CLAUDE.md's hard security constraint

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SERVICE_ROLE_KEY,
);

function emailHtml(firstName: string, routineName: string, resultText: string): string {
  const preview = resultText.length > 600 ? resultText.slice(0, 600) + "…" : resultText;
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a;line-height:1.6;background:#fff">
  <p style="font-size:13px;color:#888;font-family:monospace;margin-bottom:24px">AETHYRO</p>
  <p>Hey ${firstName},</p>
  <p>Your routine "<strong>${routineName}</strong>" just ran — here's what it found:</p>
  <div style="background:#f6f6f6;border-left:3px solid #ff4d00;padding:14px 18px;margin:20px 0;white-space:pre-wrap;font-size:14.5px">${preview}</div>
  <p style="margin:28px 0">
    <a href="${CHAT_URL}" style="display:inline-block;background:#ff4d00;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px">Open Aethyro &rarr;</a>
  </p>
  <hr style="margin:32px 0;border:none;border-top:1px solid #eee"/>
  <p style="font-size:12px;color:#999">Aethyro &middot; <a href="https://aethyro.com" style="color:#999">aethyro.com</a><br/>You received this because "${routineName}" has email notifications turned on — toggle it off any time in the Routines tab.</p>
</body>
</html>`;
}

function skippedEmailHtml(firstName: string, routineName: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a;line-height:1.6;background:#fff">
  <p style="font-size:13px;color:#888;font-family:monospace;margin-bottom:24px">AETHYRO</p>
  <p>Hey ${firstName},</p>
  <p>Your routine "<strong>${routineName}</strong>" was scheduled to run just now, but didn't — your account is out of credits, so it was skipped. It'll keep trying on its usual schedule, but it won't actually run until there's a balance to run it with.</p>
  <p style="margin:28px 0">
    <a href="${BUY_URL}" style="display:inline-block;background:#ff4d00;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px">Top up credits &rarr;</a>
  </p>
  <hr style="margin:32px 0;border:none;border-top:1px solid #eee"/>
  <p style="font-size:12px;color:#999">Aethyro &middot; <a href="https://aethyro.com" style="color:#999">aethyro.com</a><br/>You received this because "${routineName}" has email notifications turned on — toggle it off any time in the Routines tab.</p>
</body>
</html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }

  const internalKey = req.headers.get("X-Internal-Key");
  if (!SERVICE_ROLE_KEY || internalKey !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { user_id?: string; routine_name?: string; result_text?: string; skipped?: boolean; reason?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const { user_id, routine_name, result_text, skipped } = body;
  if (!user_id || !routine_name || (!skipped && !result_text)) {
    return new Response(JSON.stringify({ error: "user_id, routine_name, and (result_text or skipped) required" }), { status: 400 });
  }

  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(user_id);
  if (userErr || !userData?.user?.email) {
    return new Response(JSON.stringify({ error: "user not found" }), { status: 404 });
  }

  const email = userData.user.email;
  const firstName =
    userData.user.user_metadata?.first_name ||
    userData.user.user_metadata?.full_name?.split(" ")[0] ||
    email.split("@")[0];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: skipped ? `Your "${routine_name}" didn't run — out of credits` : `Your "${routine_name}" is ready`,
      html: skipped ? skippedEmailHtml(firstName, routine_name) : emailHtml(firstName, routine_name, result_text!),
    }),
  });

  const resData = await res.json();
  if (!res.ok) {
    console.error("Resend error", resData);
    return new Response(JSON.stringify({ error: resData }), { status: 500 });
  }

  return new Response(JSON.stringify({ sent: true, id: resData.id }), {
    headers: { "Content-Type": "application/json" },
  });
});
