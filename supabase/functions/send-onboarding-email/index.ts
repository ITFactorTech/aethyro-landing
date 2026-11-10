// send-onboarding-email -- day-1/2/3 drip (pg_cron `send-onboarding-emails`).
//
// v2 (2026-11-10): STATE-AWARE. Until now this sent fixed copy to whatever
// `email` the request body named, so (a) an account that had already spent its
// credits was told "your credits are ready", (b) an account that never sent a
// message was told "Yesterday you sent your first message", and (c) anyone who
// could reach the function (verify_jwt is false -- pg_cron calls it with the
// anon key) could make it mail an arbitrary address. Now the body's `email` is
// only a lookup key: the recipient, first name, balance and activity all come
// from the database, and any failure to establish them FAILS CLOSED (no send).
//
// Env vars required: RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = "Robert at Aethyro <hello@aethyro.com>";
const REPLY_TO = "leer4030@gmail.com";
const DASH = "https://aethyro.com/app/dashboard.html";
const CHAT = "https://aethyro.com/app/chat.html";
const PRICING = "https://aethyro.com/#pricing";

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

function wrap(body: string) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a;line-height:1.6">${body}<hr style="margin-top:40px;border:none;border-top:1px solid #eee"/><p style="font-size:12px;color:#999">Aethyro · <a href="https://aethyro.com">aethyro.com</a></p></body></html>`;
}

function btn(text: string, url: string) {
  return `<p><a href="${url}" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600">${text}</a></p>`;
}

// queue_onboarding_emails() (the on_auth_user_created_queue_emails trigger)
// only ever schedules email_num 1-3, one per day after signup. There is no
// trial and nothing to "upgrade" out of -- an account gets a free starter
// grant on signup and tops up with one-time credit packs whenever it wants.
// Only 3 templates exist now for that reason.

// What the copy may claim about this particular account. Everything here is
// read from the database for THIS send, never taken from the request body.
interface Ctx {
  name: string;         // HTML-escaped
  balance: number;      // live pooled credit balance (> 0 -- see decide())
  hasMessaged: boolean; // has sent at least one chat message
  purchased: boolean;   // has ever bought a credit pack
}

const emails: Record<number, { subject: (c: Ctx) => string; html: (c: Ctx) => string }> = {
  1: {
    subject: (c) => c.hasMessaged ? `You have ${c.balance} credits left` : `Your ${c.balance} credits are ready`,
    html: (c) => c.hasMessaged
      ? wrap(`
      <p>Hey ${c.name},</p>
      <p>Thanks for trying Aethyro. You have <strong>${c.balance} credits</strong> left, and every reply shows you exactly what it cost.</p>
      ${btn("→ Pick up where you left off", CHAT)}
      <p>If you hit any issues, reply to this email. I read every one.</p>
      <p>— Robert<br/>Founder, Aethyro</p>
    `)
      : wrap(`
      <p>Hey ${c.name},</p>
      <p>Welcome to Aethyro.</p>
      <p>You have <strong>${c.balance} credits</strong> in your account, no card required. A quick question costs about 1 credit, and every reply shows you exactly what it cost.</p>
      ${c.purchased ? "" : `<p>Your starter credits run on our fast model, which handles most everyday questions. Buy any credit pack (from $4) and you can pick <strong>Sonnet</strong> for balanced work or <strong>Opus</strong> when a problem is genuinely hard.</p>`}
      ${btn("→ Start chatting", CHAT)}
      <p>If you hit any issues, reply to this email. I read every one.</p>
      <p>— Robert<br/>Founder, Aethyro</p>
    `),
  },
  2: {
    subject: () => "What's in the Intelligence panel",
    html: (c) => wrap(`
      <p>Hey ${c.name},</p>
      <p>${c.hasMessaged
        ? "You've already started chatting. Here's a quick tour of what else is in there."
        : "You haven't sent a message yet, so here's a quick look at what's waiting for you."}</p>
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
    subject: () => "How credits actually work",
    html: (c) => wrap(`
      <p>Hey ${c.name},</p>
      <p>Every reply shows you exactly what it cost — no guessing. Roughly: <strong>Haiku ~1 credit</strong>, <strong>Sonnet ~4 credits</strong>, <strong>Opus ~15 credits</strong> per message (1 credit ≈ $0.02). Credits never expire, and you have <strong>${c.balance}</strong> right now.</p>
      <p>Two ways to get more, free:</p>
      <p><strong>Refer a friend</strong> — you both get 100 credits the moment they sign up. Your link is on your <a href="${DASH}">dashboard</a>.</p>
      <p>Or top up directly whenever you want, starting at $4 for 200 credits, no subscription:</p>
      ${btn("→ See credit packs", PRICING)}
      <p>Questions? Reply here.<br/>— Robert</p>
    `),
  },
};

function esc(v: string) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Whether an onboarding email should go out at all, given the account's real
// state. Pure, so it is unit-testable without a database.
//   * No credits left -> never. These emails say "your credits are ready" /
//     tour the product; neither is true or useful for an account at zero.
//     (An account that spent its credits chatting already got the one-time
//     "your credits ran out" email from `chat`, which carries the buy path.
//     An account that never received a grant -- a blocked signup domain --
//     has nothing to be told either, and mailing it only hurts sender
//     reputation.)
export function decide(balance: number): { send: boolean; reason?: string } {
  if (balance <= 0) return { send: false, reason: "out_of_credits" };
  return { send: true };
}

type Json = Record<string, unknown>;
const jsonHeaders = (CORS: Record<string, string>) => ({ ...CORS, "Content-Type": "application/json" });
const reply = (CORS: Record<string, string>, status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders(CORS) });

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { email, email_num } = await req.json();
    if (!email || !email_num) return reply(CORS, 400, { error: "email and email_num required" });

    const template = emails[email_num as number];
    if (!template) return reply(CORS, 400, { error: `unknown email_num: ${email_num}` });

    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // 1. Who is this? The recipient is the profile's own address; the body's
    //    `email` is only a lookup key.
    const { data: profile, error: profErr } = await supa
      .from("profiles").select("id, email").eq("email", String(email)).maybeSingle();
    if (profErr) {
      console.error("send-onboarding-email: profile lookup failed", profErr.message);
      return reply(CORS, 503, { error: "lookup failed" });
    }
    if (!profile) return reply(CORS, 200, { sent: false, skipped: "no_profile" });
    const uid = profile.id as string;
    const to = profile.email as string;

    // 2. Was this email really just dispatched by the cron? Its CTE marks the
    //    row sent=true / sent_at=now() immediately before calling us, so a
    //    request with no such recent row is not the drip. This also gives us
    //    the first name stored at signup, which we use instead of anything
    //    the caller supplied.
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: row, error: rowErr } = await supa
      .from("scheduled_emails").select("first_name")
      .eq("user_id", uid).eq("email_num", email_num).eq("sent", true).gte("sent_at", since)
      .limit(1).maybeSingle();
    if (rowErr) {
      console.error("send-onboarding-email: schedule lookup failed", rowErr.message);
      return reply(CORS, 503, { error: "lookup failed" });
    }
    if (!row) return reply(CORS, 200, { sent: false, skipped: "not_scheduled" });

    // 3. Balance (team-pool aware). get_credit_balance coalesces to 0, so a
    //    non-number can only mean the RPC itself failed: fail closed.
    const { data: balance, error: balErr } = await supa.rpc("get_credit_balance", { p_user_id: uid });
    if (balErr || typeof balance !== "number") {
      console.error("send-onboarding-email: balance lookup failed", balErr?.message ?? "non-numeric result");
      return reply(CORS, 503, { error: "lookup failed" });
    }
    const verdict = decide(balance);
    if (!verdict.send) return reply(CORS, 200, { sent: false, skipped: verdict.reason });

    // 4. Activity + purchase state, for the copy only.
    const { data: convs, error: convErr } = await supa
      .from("conversations").select("id").eq("user_id", uid).limit(50);
    if (convErr) {
      console.error("send-onboarding-email: conversation lookup failed", convErr.message);
      return reply(CORS, 503, { error: "lookup failed" });
    }
    let hasMessaged = false;
    if (convs && convs.length) {
      const { data: msg, error: msgErr } = await supa
        .from("messages").select("id").in("conversation_id", convs.map((c: { id: string }) => c.id))
        .eq("role", "user").limit(1);
      if (msgErr) {
        console.error("send-onboarding-email: message lookup failed", msgErr.message);
        return reply(CORS, 503, { error: "lookup failed" });
      }
      hasMessaged = !!(msg && msg.length);
    }
    const { data: buy, error: buyErr } = await supa
      .from("credit_ledger").select("id").eq("user_id", uid).eq("reason", "purchase").limit(1);
    if (buyErr) {
      console.error("send-onboarding-email: purchase lookup failed", buyErr.message);
      return reply(CORS, 503, { error: "lookup failed" });
    }

    const ctx: Ctx = {
      name: esc(((row.first_name as string | null) || to.split("@")[0]).trim() || "there"),
      balance, hasMessaged, purchased: !!(buy && buy.length),
    };

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        reply_to: REPLY_TO,
        to,
        subject: template.subject(ctx),
        html: template.html(ctx),
      }),
    });

    const data = await res.json();
    if (!res.ok) return reply(CORS, 500, { error: data });
    return reply(CORS, 200, { sent: true, id: data.id });
  } catch (err) {
    return reply(CORS, 500, { error: (err as Error).message });
  }
});
