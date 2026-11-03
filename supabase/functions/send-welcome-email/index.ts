// send-welcome-email v2 — fixed 2026-10-05: the day-5 "reengagement" gate
// queried messages.user_id, a column that doesn't exist (see CLAUDE.md's
// schema gotchas); the error was silently discarded, leaving the
// zero-messages check permanently true. Now scopes through conversations
// like every other per-user messages query in this codebase, and fails
// closed (skips the send) on an unexpected lookup error.
// v3 — 2026-10-08: the day-2 "engagement" email is now personalized with
// the user's earliest real conversation (title + a deep link back into it
// via chat.html's existing `?c=<id>` handling) when one exists with a
// usable title, falling back to the original generic copy otherwise. See
// `engagementHtml()`. Prompted by a real data finding: of 46 users, only 3
// ever returned on a second day.
// v4 — 2026-11-03: added a day-6 "winback" type for users who DID send
// messages on signup day but never came back on a later day (the real
// retention leak: ~50% activation, 11 users ever returned). Unlike the other
// types it ignores the caller's `email` and re-derives everything from
// `user_id` server-side, and re-checks eligibility before sending, so a
// direct call (verify_jwt=false) can at most trigger the one legitimate,
// one-time email for a genuinely eligible user. See winbackHtml().
// Called by a Postgres trigger (via pg_net) when a new row appears in auth.users.
// Sends a 3-step drip:
//   day 0 — welcome + starter prompts
//   day 2 — engagement nudge (checked by the daily run-routines job)
//   day 5 — re-engagement if user has sent zero messages
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

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

// Minimal HTML-escaping for a value interpolated into an email template.
// `conversations.title` is AI-generated (chat.html's `aiTitle`, ~line 1749)
// and normally a short plain string, but it's still untrusted user-session
// data -- escape it rather than assume it's safe to drop into markup raw.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Personalized (title + conversationId both present, title non-empty): a
// direct line naming the user's own first conversation, CTA deep-links
// straight back into it via chat.html's existing `?c=<id>` handling
// (confirmed live: chat.html already reads `?c=` via URLSearchParams and
// calls loadConversation() with it -- no new deep-link mechanism needed).
// Otherwise (no conversation yet, null/empty title, or the caller's lookup
// errored): exact original generic copy, unchanged. Fail closed/generic --
// never guess or fabricate a topic the user didn't actually ask about.
function engagementHtml(ctx?: { title?: string | null; conversationId?: string | null }): string {
  const title = ctx?.title;
  const conversationId = ctx?.conversationId;
  if (title && conversationId) {
    const ctaUrl = `${BASE_URL}/app/chat.html?c=${encodeURIComponent(conversationId)}`;
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="font-size:1.1rem;font-weight:700;margin-bottom:32px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff4d00;margin-right:6px;vertical-align:middle"></span>
    Aethyro
  </div>
  <h1 style="font-size:1.5rem;font-weight:800;margin:0 0 12px">Pick up where you left off</h1>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 24px">
    You were asking about <strong style="color:#f0f0f0">${escapeHtml(title)}</strong> — want to pick that back up?
  </p>
  <a href="${ctaUrl}" style="display:inline-block;padding:12px 28px;background:#ff4d00;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem">
    Continue the conversation →
  </a>
  <hr style="border:none;border-top:1px solid #222;margin:28px 0"/>
  <p style="font-size:.78rem;color:#555">Reply any time — we'd love to hear what you're working on.</p>
</div>
</body>
</html>`;
  }
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

function winbackHtml(ctx: { title?: string | null; conversationId?: string | null; balance?: number | null }): string {
  const ctaUrl = ctx.title && ctx.conversationId
    ? `${BASE_URL}/app/chat.html?c=${encodeURIComponent(ctx.conversationId)}`
    : `${BASE_URL}/app/chat.html`;
  const opener = ctx.title
    ? `A few days ago you asked Aethyro about <strong style="color:#f0f0f0">${escapeHtml(ctx.title)}</strong>. That conversation is saved and ready to continue.`
    : `Your earlier conversations are saved and ready to continue.`;
  const balanceLine = typeof ctx.balance === "number" && ctx.balance >= 20
    ? `<p style="color:#a0a0a0;line-height:1.65;margin:0 0 24px">You still have <strong style="color:#f0f0f0">${ctx.balance} credits</strong>. They never expire.</p>`
    : "";
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',sans-serif;color:#f0f0f0">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <div style="font-size:1.1rem;font-weight:700;margin-bottom:32px">
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ff4d00;margin-right:6px;vertical-align:middle"></span>
    Aethyro
  </div>
  <h1 style="font-size:1.5rem;font-weight:800;margin:0 0 12px">Want to take it one step further?</h1>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 16px">${opener}</p>
  ${balanceLine}
  <a href="${ctaUrl}" style="display:inline-block;padding:12px 28px;background:#ff4d00;color:#fff;font-weight:700;border-radius:8px;text-decoration:none;font-size:.9rem;margin-bottom:28px">
    Continue where you left off →
  </a>
  <p style="color:#a0a0a0;line-height:1.65;margin:0 0 8px"><strong style="color:#f0f0f0">Or let Aethyro come to you.</strong> Set up a Routine and it runs a prompt on a schedule and emails you the result, for example:</p>
  <ul style="color:#a0a0a0;line-height:1.8;padding-left:1.4rem;margin:0 0 24px">
    <li>"Every Monday, give me a prioritized plan for the week"</li>
    <li>"Each morning, summarize the top news in my industry"</li>
  </ul>
  <a href="${BASE_URL}/app/chat.html" style="color:#ff4d00;font-weight:700;text-decoration:none;font-size:.9rem">Set up a Routine (Intelligence → Routines) →</a>
  <hr style="border:none;border-top:1px solid #222;margin:28px 0"/>
  <p style="font-size:.78rem;color:#555">This is the last check-in email we'll send. Reply any time and tell us what would make Aethyro more useful.</p>
</div>
</body>
</html>`;
}

serve(async (req) => {
  const CORS = corsHeadersFor(req);
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

    if (!email && emailType !== "winback") return new Response(JSON.stringify({ error: "no email" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });

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
      // Personalize with the user's earliest real conversation when it has
      // a usable title, so the day-2 nudge references what they actually
      // asked about instead of generic copy (Oracle's finding: only 3 of 46
      // users ever returned a second day). Fail closed to the original
      // generic copy on no conversation, a null/empty title, or any lookup
      // error -- never guess at a topic.
      let engagementCtx: { title?: string | null; conversationId?: string | null } = {};
      try {
        const { data: firstConvo, error: convoErr } = await supabase
          .from("conversations")
          .select("id,title")
          .eq("user_id", userId)
          .order("created_at", { ascending: true })
          .limit(1);
        if (convoErr) {
          console.error("send-welcome-email: engagement conversation lookup failed", convoErr.message);
        } else if (firstConvo && firstConvo.length > 0 && firstConvo[0].title) {
          engagementCtx = { title: firstConvo[0].title, conversationId: firstConvo[0].id };
        }
      } catch (lookupErr) {
        console.error("send-welcome-email: engagement conversation lookup threw", lookupErr);
      }
      await sendEmail(email, "A few things Aethyro does really well", engagementHtml(engagementCtx));
      await supabase.from("email_drip_state").upsert({
        user_id: userId,
        engagement_sent_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    } else if (emailType === "reengagement") {
      // Only send if the user has genuinely sent zero real messages.
      // `messages` has no user_id column (see CLAUDE.md's schema gotchas) --
      // the original `.eq("user_id", userId)` queried a column that doesn't
      // exist, which PostgREST rejects with 42703; the destructured
      // `{ count }` silently discarded that error, leaving count null and
      // `(count || 0) === 0` permanently true. That meant this email has
      // been sent to every day-5 candidate unconditionally, not just
      // genuinely silent ones -- it just hadn't been caught live yet
      // because every real candidate so far also happened to have zero
      // messages. Scope through conversations like every other per-user
      // messages query in this codebase, and fail closed (skip the send)
      // on an unexpected error rather than risk telling an active user
      // their credits are "still waiting".
      let hasMessages = true;
      const { data: convos, error: convErr } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", userId);
      if (convErr) {
        console.error("send-welcome-email: conversation lookup failed", convErr.message);
      } else {
        const convoIds = (convos || []).map((c: { id: string }) => c.id);
        if (convoIds.length === 0) {
          hasMessages = false;
        } else {
          const { count, error: countErr } = await supabase
            .from("messages")
            .select("id", { count: "exact", head: true })
            .in("conversation_id", convoIds);
          if (countErr) {
            console.error("send-welcome-email: message count failed", countErr.message);
          } else {
            hasMessages = (count || 0) > 0;
          }
        }
      }
      if (!hasMessages) {
        await sendEmail(email, "Your 200 Aethyro credits are still waiting", reengagementHtml());
        await supabase.from("email_drip_state").upsert({
          user_id: userId,
          reengagement_sent_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      }
    } else if (emailType === "winback") {
      // Never trust the caller's email for this type: derive it from user_id.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(userId || ""))) {
        return new Response(JSON.stringify({ error: "invalid user_id" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const { data: userRes, error: userErr } = await supabase.auth.admin.getUserById(userId);
      if (userErr || !userRes?.user?.email) {
        return new Response(JSON.stringify({ ok: false, skipped: "unknown user" }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const user = userRes.user;
      const signupMs = new Date(user.created_at).getTime();
      const ageDays = (Date.now() - signupMs) / 86400000;

      const { data: drip } = await supabase.from("email_drip_state")
        .select("winback_sent_at").eq("user_id", userId).maybeSingle();

      // Eligibility, fail closed on any lookup error: 6-30 days old, not yet
      // won back, sent >=1 message, and no message on any later day.
      let eligible = !drip?.winback_sent_at && ageDays >= 6 && ageDays <= 30;
      let ctx: { title?: string | null; conversationId?: string | null; balance?: number | null } = {};
      if (eligible) {
        const { data: convos, error: convErr } = await supabase
          .from("conversations").select("id,title,updated_at")
          .eq("user_id", userId).order("updated_at", { ascending: false });
        const ids = (convos || []).map((c: { id: string }) => c.id);
        if (convErr || ids.length === 0) {
          eligible = false;
        } else {
          const returnedCutoff = new Date(signupMs + 86400000).toISOString();
          const { count: later, error: laterErr } = await supabase.from("messages")
            .select("id", { count: "exact", head: true })
            .in("conversation_id", ids).eq("role", "user").gte("created_at", returnedCutoff);
          if (laterErr || (later || 0) > 0) eligible = false;
          const titled = (convos || []).find((c: { title: string | null }) => c.title);
          if (titled) ctx = { title: titled.title, conversationId: titled.id };
        }
      }
      if (eligible) {
        // Personal balance only; team members draw from a pooled balance this
        // sum doesn't reflect, so omit the line for them rather than misstate it.
        try {
          const { data: prof } = await supabase.from("profiles").select("team_id").eq("id", userId).maybeSingle();
          if (!prof?.team_id) {
            const { data: rows, error: balErr } = await supabase.from("credit_ledger").select("delta").eq("user_id", userId);
            if (!balErr) ctx.balance = (rows || []).reduce((t: number, r: { delta: number }) => t + r.delta, 0);
          }
        } catch (_) { /* balance line is optional */ }
        await sendEmail(user.email!, "Pick up where you left off on Aethyro", winbackHtml(ctx));
      }
      // Stamp either way so the daily cron never re-selects this user (the
      // drip-reengagement requery bug fixed 2026-10-27).
      if (!drip?.winback_sent_at) {
        await supabase.from("email_drip_state").upsert({
          user_id: userId,
          winback_sent_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      }
      return new Response(JSON.stringify({ ok: true, type: emailType, sent: eligible }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
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
