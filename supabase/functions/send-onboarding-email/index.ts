import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "Robert at Aethyro <hello@aethyro.com>";
const REPLY_TO = "leer4030@gmail.com";
const DASH = "https://aethyro.com/app/dashboard.html";
const CHAT = "https://aethyro.com/app/chat.html";
const PRICING = "https://aethyro.com/#pricing";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function wrap(body: string) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a;line-height:1.6">${body}<hr style="margin-top:40px;border:none;border-top:1px solid #eee"/><p style="font-size:12px;color:#999">Aethyro · <a href="https://aethyro.com">aethyro.com</a></p></body></html>`;
}

function btn(text: string, url: string) {
  return `<p><a href="${url}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600">${text}</a></p>`;
}

// queue_onboarding_emails() (the on_auth_user_created_queue_emails trigger)
// only ever schedules email_num 1-3, one per day after signup. There is no
// trial and nothing to "upgrade" out of -- every account gets 200 free
// credits on signup, permanently, and tops up with one-time credit packs
// whenever they want. Only 3 templates exist now for that reason.
const emails: Record<number, { subject: string; html: (name: string) => string }> = {
  1: {
    subject: "Your 200 free credits are ready",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>Welcome to Aethyro.</p>
      <p>You started with <strong>200 free credits</strong>, automatically, no card required. That's enough for dozens of conversations right now.</p>
      <p>Pick your model per message: <strong>Haiku</strong> for quick, everyday questions, <strong>Sonnet</strong> for balanced everyday work, or <strong>Opus</strong> when a problem is genuinely hard.</p>
      ${btn("→ Start chatting", CHAT)}
      <p>If you hit any issues, reply to this email. I read every one.</p>
      <p>— Robert<br/>Founder, Aethyro</p>
    `),
  },
  2: {
    subject: "What's in the Intelligence panel",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>Yesterday you sent your first message. Today, a quick tour of what else is in there.</p>
      <p>Open <strong>Intelligence</strong> in the sidebar and you'll find:</p>
      <ul>
        <li><strong>Agentic tasks</strong> — hand off a multi-step goal and let it run</li>
        <li><strong>Document knowledge base</strong> — upload files, Aethyro references them in chat</li>
        <li><strong>Scheduled routines</strong> — a prompt that runs on a cron schedule, no babysitting</li>
        <li><strong>Memory</strong> — what Aethyro's remembered about you, visible and editable, delete anything you don't want kept</li>
        <li><strong>GitHub / Notion connectors</strong> — bring your own context in</li>
      </ul>
      ${btn("→ Open Intelligence", CHAT)}
    `),
  },
  3: {
    subject: "How credits actually work",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>Every reply shows you exactly what it cost — no guessing. Roughly: <strong>Haiku ~1 credit</strong>, <strong>Sonnet ~4 credits</strong>, <strong>Opus ~15 credits</strong> per message (1 credit ≈ $0.02). Credits never expire.</p>
      <p>Two ways to get more, free:</p>
      <p><strong>Refer a friend</strong> — you both get 100 credits the moment they sign up. Your link is on your <a href="${DASH}">dashboard</a>.</p>
      <p>Or top up directly whenever you want, starting at $4 for 200 credits, no subscription:</p>
      ${btn("→ See credit packs", PRICING)}
      <p>Questions? Reply here.<br/>— Robert</p>
    `),
  },
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { email, first_name, email_num } = await req.json();
    if (!email || !email_num) {
      return new Response(JSON.stringify({ error: "email and email_num required" }), { status: 400, headers: CORS });
    }

    const template = emails[email_num as number];
    if (!template) {
      return new Response(JSON.stringify({ error: `unknown email_num: ${email_num}` }), { status: 400, headers: CORS });
    }

    const name = first_name || email.split("@")[0];
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        reply_to: REPLY_TO,
        to: email,
        subject: template.subject,
        html: template.html(name),
      }),
    });

    const data = await res.json();
    if (!res.ok) return new Response(JSON.stringify({ error: data }), { status: 500, headers: CORS });
    return new Response(JSON.stringify({ sent: true, id: data.id }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
});
