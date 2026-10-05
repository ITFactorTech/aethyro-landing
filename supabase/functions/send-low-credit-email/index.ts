import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FROM = "Robert at Aethyro <hello@aethyro.com>";
const REPLY_TO = "leer4030@gmail.com";
const BUY_URL = "https://aethyro.com/#pricing";
const COOLDOWN_DAYS = 7;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SERVICE_ROLE_KEY
);

function emailHtml(firstName: string, balance: number, depleted: boolean): string {
  const intro = depleted
    ? `<p>Hey ${firstName},</p><p>You're out of credits — your AI chat is paused until you top up.</p>`
    : `<p>Hey ${firstName},</p><p>You're down to <strong>${balance} credits</strong> — enough for a few more conversations before your AI goes quiet.</p>`;
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto;color:#1a1a1a;line-height:1.6;background:#fff">
  <p style="font-size:13px;color:#888;font-family:monospace;margin-bottom:24px">AETHYRO</p>
  ${intro}
  <p>Top up now and keep going without interruption. Credits never expire, so anything you add stays until you use it.</p>
  <p style="margin:28px 0">
    <a href="${BUY_URL}" style="display:inline-block;background:#ff4d00;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px">Top up credits &rarr;</a>
  </p>
  <p style="color:#666;font-size:14px">200 credits &nbsp;&middot;&nbsp; 600 credits &nbsp;&middot;&nbsp; 2,000 credits &nbsp;&middot;&nbsp; 7,000 credits<br/>Starting at $4. No subscription. No expiry.</p>
  <hr style="margin:32px 0;border:none;border-top:1px solid #eee"/>
  <p style="font-size:12px;color:#999">Aethyro &middot; <a href="https://aethyro.com" style="color:#999">aethyro.com</a><br/>You received this because your credit balance is ${depleted ? "depleted" : "running low"}.</p>
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

  // Require the service role key as a shared internal secret
  const internalKey = req.headers.get("X-Internal-Key");
  if (!SERVICE_ROLE_KEY || internalKey !== SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { user_id?: string; balance?: number; depleted?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const { user_id, balance, depleted } = body;
  if (!user_id || balance === undefined) {
    return new Response(JSON.stringify({ error: "user_id and balance required" }), { status: 400 });
  }

  // "depleted" (balance <= 0) uses its own cooldown column, separate from
  // the 1-30-credit warning's, so a user who blew past the warning window
  // in one large reply isn't blocked from this email by an unrelated
  // cooldown they never actually triggered.
  const cooldownColumn = depleted ? "credits_depleted_warned_at" : "low_credit_warned_at";

  // Check 7-day cooldown
  const { data: profile } = await supabase
    .from("profiles")
    .select(cooldownColumn)
    .eq("id", user_id)
    .single();

  const warnedAt = (profile as Record<string, string | null> | null)?.[cooldownColumn];
  if (warnedAt) {
    const daysSince = (Date.now() - new Date(warnedAt).getTime()) / 86_400_000;
    if (daysSince < COOLDOWN_DAYS) {
      return new Response(JSON.stringify({ skipped: true, reason: "cooldown" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Get user email from auth.users
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(user_id);
  if (userErr || !userData?.user?.email) {
    return new Response(JSON.stringify({ error: "user not found" }), { status: 404 });
  }

  const email = userData.user.email;
  const firstName =
    userData.user.user_metadata?.first_name ||
    userData.user.user_metadata?.full_name?.split(" ")[0] ||
    email.split("@")[0];

  // Send via Resend
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
      subject: depleted ? "Your Aethyro credits ran out" : `You have ${balance} Aethyro credits left`,
      html: emailHtml(firstName, balance, !!depleted),
    }),
  });

  const resData = await res.json();
  if (!res.ok) {
    console.error("Resend error", resData);
    return new Response(JSON.stringify({ error: resData }), { status: 500 });
  }

  // Mark warned
  await supabase
    .from("profiles")
    .update({ [cooldownColumn]: new Date().toISOString() })
    .eq("id", user_id);

  return new Response(JSON.stringify({ sent: true, id: resData.id }), {
    headers: { "Content-Type": "application/json" },
  });
});
