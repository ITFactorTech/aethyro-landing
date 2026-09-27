import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const BONUS = 100;
const MAX_AGE_HOURS = 72;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  // Resolve caller identity
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  // Parse body
  let code: string;
  try {
    const body = await req.json();
    code = (body.code ?? "").trim().toUpperCase();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!code) return json({ error: "code is required" }, 400);

  // Enforce 72-hour account age window
  const ageMs = Date.now() - new Date(user.created_at).getTime();
  if (ageMs > MAX_AGE_HOURS * 3600 * 1000) {
    return json({ error: "Referral codes must be redeemed within 72 hours of signup" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Look up the referral code
  const { data: codeRow, error: codeErr } = await admin
    .from("referral_codes")
    .select("user_id")
    .eq("code", code)
    .single();
  if (codeErr || !codeRow) return json({ error: "Invalid referral code" }, 404);

  const referrerId = codeRow.user_id;

  // No self-referral
  if (referrerId === user.id) return json({ error: "Cannot redeem your own referral code" }, 400);

  // Check already redeemed
  const { data: existing } = await admin
    .from("referral_events")
    .select("id")
    .eq("referee_user_id", user.id)
    .maybeSingle();
  if (existing) return json({ error: "You have already redeemed a referral code" }, 409);

  // Record event — UNIQUE on referee_user_id guards against races
  const { error: eventErr } = await admin
    .from("referral_events")
    .insert({ referrer_user_id: referrerId, referee_user_id: user.id });
  if (eventErr) {
    if (eventErr.code === "23505") return json({ error: "Referral already redeemed" }, 409);
    console.error("referral_events insert", eventErr);
    return json({ error: "Failed to record referral" }, 500);
  }

  // Grant credits to both parties
  const now = new Date().toISOString();
  const { error: creditErr } = await admin.from("credit_ledger").insert([
    { user_id: referrerId, delta: BONUS, reason: "referral_bonus", created_at: now },
    { user_id: user.id,    delta: BONUS, reason: "referral_bonus", created_at: now },
  ]);
  if (creditErr) {
    console.error("credit_ledger insert", creditErr);
    return json({ error: "Credits could not be applied; please contact support" }, 500);
  }

  return json({ success: true, credits_added: BONUS });
});
