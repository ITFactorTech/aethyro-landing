// send-routine-result-email v1 — the return-visit hook: run-routines calls
// this right after a routine's scheduled/webhook/chained/manual run
// completes successfully, if that routine has email_on_result = true, so
// a result produced while the user wasn't looking at the app is still a
// reason to come back, instead of sitting silently in the Routines tab
// until they happen to open it. Same internal-auth pattern as
// send-low-credit-email (X-Internal-Key, not a Supabase session JWT,
// since the caller is run-routines' own service-role client, never a
// real user).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM = "Aethyro <hello@aethyro.com>";
const CHAT_URL = "https://aethyro.com/app/chat.html";

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, x-internal-key",
      },
    });
  }

  const internalKey = req.headers.get("X-Internal-Key");
  if (!SERVICE_ROLE_KEY || internalKey !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { user_id?: string; routine_name?: string; result_text?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const { user_id, routine_name, result_text } = body;
  if (!user_id || !routine_name || !result_text) {
    return new Response(JSON.stringify({ error: "user_id, routine_name, and result_text required" }), { status: 400 });
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
      subject: `Your "${routine_name}" is ready`,
      html: emailHtml(firstName, routine_name, result_text),
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
