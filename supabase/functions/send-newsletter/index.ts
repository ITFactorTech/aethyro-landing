// send-newsletter — admin-triggered broadcast of an issue via Resend.
// Auth: header `x-admin-secret` must equal ADMIN_SEND_SECRET. (verify_jwt=false)
// Body: { slug, test_to? }  — test_to sends only to that address.
// Free issue -> newsletter_signups; premium issue -> active subscribers.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const FROM = Deno.env.get("NEWSLETTER_FROM") ?? "Aethyro <onboarding@resend.dev>";
const ADMIN = Deno.env.get("ADMIN_SEND_SECRET")!;

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function htmlBody(issue: { title: string; body: string; slug: string }) {
  const body = issue.body.split("\n").map((l) => l.trim() === "" ? "<br>" : `<p style="margin:0 0 12px">${esc(l)}</p>`).join("");
  return `<div style="font-family:system-ui,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;padding:8px">
    <h1 style="font-size:22px">${esc(issue.title)}</h1>${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
    <p style="font-size:12px;color:#888">The Aethyro Dispatch · <a href="https://aethyro.com/app/newsletter.html">read on the web</a> · <a href="https://aethyro.com">aethyro.com</a></p>
  </div>`;
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-admin-secret") !== ADMIN) return json({ error: "unauthorized" }, 401);
  try {
    const { slug, test_to } = await req.json();
    const { data: issue } = await admin.from("newsletter_issues").select("slug,title,body,is_premium").eq("slug", slug).single();
    if (!issue) return json({ error: "issue not found" }, 404);

    let recipients: string[] = [];
    if (test_to) recipients = [test_to];
    else if (issue.is_premium) {
      const r = await admin.rpc("active_subscriber_emails");
      recipients = (r.data ?? []).map((x: { email: string }) => x.email);
    } else {
      const r = await admin.from("newsletter_signups").select("email");
      recipients = (r.data ?? []).map((x: { email: string }) => x.email);
    }
    recipients = [...new Set(recipients.filter(Boolean))];
    if (!recipients.length) return json({ sent: 0, note: "no recipients for this issue" });

    const html = htmlBody(issue);
    let sent = 0;
    for (let i = 0; i < recipients.length; i += 100) {
      const chunk = recipients.slice(i, i + 100).map((to) => ({ from: FROM, to: [to], subject: issue.title, html }));
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) return json({ sent, error: "resend: " + (await res.text()) }, 502);
      sent += chunk.length;
    }
    return json({ sent, recipients: recipients.length, premium: issue.is_premium });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
