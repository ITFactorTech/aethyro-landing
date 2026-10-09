// Internal-only (X-Internal-Key, not verify_jwt) -- fires at most once ever
// per user, when chat/index.ts's finalize() calls request_testimonial_if_eligible
// and gets a fresh token back. Same CORS/auth shape as send-low-credit-email.
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
const FROM = "Robert at Aethyro <hello@aethyro.com>";
const REPLY_TO = "leer4030@gmail.com";
const FEEDBACK_BASE = "https://aethyro.com/app/feedback.html";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SERVICE_ROLE_KEY
);

function emailHtml(firstName: string, feedbackUrl: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a;line-height:1.6;background:#fff">
  <p style="font-size:13px;color:#888;font-family:monospace;margin-bottom:24px">AETHYRO</p>
  <p>Hey ${firstName},</p>
  <p>I'm building Aethyro solo, and you've actually used it enough that your take on it would mean a lot more than a generic review-site ask.</p>
  <p>Would you be up for 2-3 honest sentences about your experience — good, bad, whatever's true? Takes about 30 seconds, and I'd only ever use it publicly with your okay.</p>
  <p style="margin:28px 0">
    <a href="${feedbackUrl}" style="display:inline-block;background:#ff4d00;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px">Share a quick thought &rarr;</a>
  </p>
  <p style="color:#666;font-size:14px">No pressure at all if not — just appreciate you using the thing.</p>
  <hr style="margin:32px 0;border:none;border-top:1px solid #eee"/>
  <p style="font-size:12px;color:#999">Aethyro &middot; <a href="https://aethyro.com" style="color:#999">aethyro.com</a><br/>This is a one-time ask — you won't get this email again.</p>
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

  let body: { user_id?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const { user_id, token } = body;
  if (!user_id || !token) {
    return new Response(JSON.stringify({ error: "user_id and token required" }), { status: 400 });
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

  const feedbackUrl = `${FEEDBACK_BASE}?t=${encodeURIComponent(token)}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      reply_to: REPLY_TO,
      to: email,
      subject: "quick favor?",
      html: emailHtml(firstName, feedbackUrl),
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
