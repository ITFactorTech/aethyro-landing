// send-welcome-email v1
// Called by a Postgres trigger (via pg_net) when a new row appears in auth.users.
// Sends a 3-step drip:
//   day 0 — welcome + starter prompts
//   day 2 — engagement nudge (checked by the daily run-routines job)
//   day 5 — re-engagement if user has sent zero messages
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "Aethyro <hello@aethyro.com>";
const BASE_URL = "https://aethyro.com";

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

function welcomeHtml(email: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="font-size:1.1rem;font-weight:700;margin-bottom:32px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff4d00;margin-right:6px;vertical-align:middle"></span>
    Aethyro
  </div>
  <h1 style="font-size:1.6rem;font-weight:800;margin:0 0 12px;line-height:1.2">Welcome — you're in.</h1>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 24px">
    Your account is ready with <strong style="color:#f0f0f0">200 free credits</strong>.
    Each message costs 1–5 credits depending on length, so you have plenty to explore.
  </p>

  <p style="font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#666;margin:0 0 10px">
    Try these to get started
  </p>
  <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:28px">
    ${[
      "Explain quantum entanglement like I'm 10",
      "Write a Python script that monitors a website for changes",
      "Summarize this article and extract the 3 key takeaways",
      "Draft a cold email for my SaaS product",
    ].map(p => `
    <a href="${BASE_URL}/app/chat.html" style="display:block;padding:10px 14px;background:#161616;border:1px solid #2a2a2a;border-radius:8px;color:#f0f0f0;text-decoration:none;font-size:.85rem;line-height:1.4">
      "${p}"
    </a>`).join("")}
  </div>

  <a href="${BASE_URL}/app/chat.html" style="display:inline-block;padding:12px 28px;background:#ff4d00;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem;margin-bottom:28px">
    Start chatting →
  </a>

  <hr style="border:none;border-top:1px solid #222;margin:28px 0"/>
  <p style="font-size:.78rem;color:#555;line-height:1.6">
    You're receiving this because you signed up for Aethyro Cloud.<br/>
    Questions? Reply to this email — we read every one.
  </p>
</div>
</body>
</html>`;
}

function engagementHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="font-size:1.1rem;font-weight:700;margin-bottom:32px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff4d00;margin-right:6px;vertical-align:middle"></span>
    Aethyro
  </div>
  <h1 style="font-size:1.5rem;font-weight:800;margin:0 0 12px">A few things Aethyro does really well</h1>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 24px">
    You've got credits ready to use. Here are the use cases where Claude Opus 5 shines most:
  </p>
  <ul style="color:#a0a0a0;line-height:1.8;padding-left:1.4rem;margin:0 0 24px">
    <li><strong style="color:#f0f0f0">Long documents</strong> — paste an entire PDF, contract, or report and ask questions</li>
    <li><strong style="color:#f0f0f0">Code review</strong> — share a function or PR diff and get expert feedback</li>
    <li><strong style="color:#f0f0f0">Reasoning chains</strong> — multi-step analysis that GPT-4 struggles with</li>
    <li><strong style="color:#f0f0f0">Writing</strong> — drafts that sound human, not AI-generated</li>
  </ul>
  <a href="${BASE_URL}/app/chat.html" style="display:inline-block;padding:12px 28px;background:#ff4d00;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem">
    Open Aethyro →
  </a>
  <hr style="border:none;border-top:1px solid #222;margin:28px 0"/>
  <p style="font-size:.78rem;color:#555">Reply any time — we'd love to hear what you're working on.</p>
</div>
</body>
</html>`;
}

function reengagementHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="font-size:1.1rem;font-weight:700;margin-bottom:32px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff4d00;margin-right:6px;vertical-align:middle"></span>
    Aethyro
  </div>
  <h1 style="font-size:1.5rem;font-weight:800;margin:0 0 12px">Your 200 credits are still waiting</h1>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 24px">
    You haven't sent a message yet — that's okay. Sometimes it helps to have a specific task in mind.
  </p>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 24px">
    <strong style="color:#f0f0f0">One idea:</strong> paste something you're currently working on — a draft email, a block of code, a document — and ask Aethyro to improve it. Takes 30 seconds.
  </p>
  <a href="${BASE_URL}/app/chat.html" style="display:inline-block;padding:12px 28px;background:#ff4d00;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem;margin-bottom:28px">
    Try it now →
  </a>
  <hr style="border:none;border-top:1px solid #222;margin:28px 0"/>
  <p style="font-size:.78rem;color:#555">Credits never expire. No pressure — we just want you to get value from Aethyro.</p>
</div>
</body>
</html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    // Called directly: { type: "welcome"|"engagement"|"reengagement", user_id, email }
    // Also called by Auth hook trigger: { type: "INSERT", record: { id, email } }
    let userId: string, email: string, emailType: string;

    if (body.record) {
      // Auth hook format
      userId = body.record.id;
      email = body.record.email;
      emailType = "welcome";
    } else {
      userId = body.user_id;
      email = body.email;
      emailType = body.type || "welcome";
    }

    if (!email) return new Response(JSON.stringify({ error: "no email" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (emailType === "welcome") {
      await sendEmail(email, "Welcome to Aethyro — you have 200 free credits", welcomeHtml(email));
      // Record drip state
      await supabase.from("email_drip_state").upsert({
        user_id: userId,
        welcome_sent_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    } else if (emailType === "engagement") {
      await sendEmail(email, "A few things Aethyro does really well", engagementHtml());
      await supabase.from("email_drip_state").upsert({
        user_id: userId,
        engagement_sent_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    } else if (emailType === "reengagement") {
      // Only send if user has no messages
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if ((count || 0) === 0) {
        await sendEmail(email, "Your 200 Aethyro credits are still waiting", reengagementHtml());
        await supabase.from("email_drip_state").upsert({
          user_id: userId,
          reengagement_sent_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      }
    }

    return new Response(JSON.stringify({ ok: true, type: emailType }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
