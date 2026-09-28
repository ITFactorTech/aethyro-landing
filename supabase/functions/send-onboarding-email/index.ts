import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "Robert at Aethyro <hello@aethyro.com>";
const REPLY_TO = "leer4030@gmail.com";
const DASH = "https://aethyro.com/app/dashboard.html";

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

const emails: Record<number, { subject: string; html: (name: string) => string }> = {
  1: {
    subject: "Your AI is ready. Here's what to do first.",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>Welcome to Aethyro.</p>
      <p>Most AI tools rent you access to someone else's computer and bill you every time you use it. You just signed up for something that runs on <em>your</em> hardware instead.</p>
      <p>Your 14-day trial starts now. No credit card charged yet.</p>
      <p><strong>Your first step:</strong> Open your dashboard and connect the app to your account. It takes about 4 minutes.</p>
      ${btn("→ Go to your dashboard", DASH)}
      <p>If you hit any issues, reply to this email. I read every one.</p>
      <p>— Robert<br/>Founder, Aethyro</p>
    `),
  },
  2: {
    subject: "What's running on your computer right now",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>Yesterday you signed up. Today I want to show you what you actually have.</p>
      <p>Inside your Aethyro install, there are 6 specialist agents:</p>
      <ul>
        <li><strong>Avery</strong> — Your general assistant. Ask it anything.</li>
        <li><strong>ORACLE</strong> — Business intelligence. Turns your data into decisions.</li>
        <li><strong>FORGE</strong> — Risk analysis. Finds what's missing before it costs you.</li>
        <li><strong>CODEX</strong> — Technical work. Code review, architecture, debugging.</li>
        <li><strong>SENTINEL</strong> — Security. Monitors your setup and flags threats.</li>
        <li><strong>NEXUS</strong> — Strategy. Synthesizes everything into a 48-hour action plan.</li>
      </ul>
      <p>None of them call home. Your data stays on your machine.</p>
      <p><strong>Try this today:</strong> Open the console and ask Avery: <em>"What are the 3 biggest risks in my current business?"</em></p>
      ${btn("→ Open your console", DASH)}
    `),
  },
  3: {
    subject: 'Why "$0 per query" changes everything',
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>If you've used ChatGPT or Claude for work, you've paid per query — even if it's buried in a subscription.</p>
      <p>At 50 queries/day × $0.02/query = $1/day = <strong>$365/year</strong>. For one person.</p>
      <p>Aethyro runs locally. After setup, each query costs <strong>$0.00</strong>. You own the compute.</p>
      <p>For a 5-person team: that's potentially $1,800/year back in your pocket — at the Personal plan price of $29/month ($348/year), you're ahead by over $1,400.</p>
      <p><strong>This week's challenge:</strong> Run 10 real tasks through Aethyro that you'd normally pay for. Track the time saved.</p>
      ${btn("→ Your dashboard", DASH)}
    `),
  },
  4: {
    subject: "7 days in — are you getting value?",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>You're halfway through your trial. Honest question: are you getting value?</p>
      <p>If yes — great. Upgrade before your trial ends to keep everything running.</p>
      <p>If no — I want to know why. Reply to this email. Every piece of feedback shapes what we build next.</p>
      <p><strong>Most common setup issues:</strong></p>
      <ol>
        <li>Ollama isn't running → run <code>ollama serve</code> in a terminal</li>
        <li>No model downloaded → run <code>ollama pull llama3</code> first</li>
        <li>Console shows offline → restart the app</li>
      </ol>
      <p>Plans start at $29/month. Less than a dinner out. Cancel anytime.</p>
      ${btn("→ See plans and upgrade", DASH)}
    `),
  },
  5: {
    subject: "Your trial ends in 2 days",
    html: (n) => wrap(`
      <p>Hey ${n},</p>
      <p>Your 14-day free trial ends in 2 days.</p>
      <p>After that, access pauses. Everything you've set up — your agents, your workflows, your local model — stays on your machine, but the platform goes dark until you subscribe.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0">
        <tr style="background:#f5f5f5"><th style="padding:10px;text-align:left">Plan</th><th style="padding:10px;text-align:left">Price</th><th style="padding:10px;text-align:left">Best for</th></tr>
        <tr><td style="padding:10px;border-top:1px solid #eee">Personal</td><td style="padding:10px;border-top:1px solid #eee">$29/mo</td><td style="padding:10px;border-top:1px solid #eee">Individuals, freelancers</td></tr>
        <tr><td style="padding:10px;border-top:1px solid #eee">Research</td><td style="padding:10px;border-top:1px solid #eee">$199/mo</td><td style="padding:10px;border-top:1px solid #eee">Analysts, academics</td></tr>
        <tr><td style="padding:10px;border-top:1px solid #eee">Developer</td><td style="padding:10px;border-top:1px solid #eee">$299/mo</td><td style="padding:10px;border-top:1px solid #eee">Builders, engineering teams</td></tr>
        <tr><td style="padding:10px;border-top:1px solid #eee">Professional</td><td style="padding:10px;border-top:1px solid #eee">$499/mo</td><td style="padding:10px;border-top:1px solid #eee">CPA firms, legal, consulting</td></tr>
      </table>
      <p>All plans include: unlimited local queries, all 6 agents, full console access, and email support.</p>
      ${btn("→ Pick a plan and keep going", DASH)}
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
