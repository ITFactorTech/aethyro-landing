// setup-auto-topup — creates a Stripe Checkout Session in `setup` mode to
// save a payment method for off-session auto-topup charges. Mirrors
// buy-credits' customer-lookup-or-create pattern exactly.
//
// This does NOT enable auto-topup by itself. stripe-webhook's
// checkout.session.completed handler (the mode === "setup" branch) does
// that once the card is actually confirmed — same session-then-webhook
// split as the real purchase flow in buy-credits/stripe-webhook.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import { CREDIT_PACKS } from "../_shared/packs.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-04-10" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Derived from the single source of truth in ../_shared/packs.ts.
const VALID_PACKS = Object.keys(CREDIT_PACKS);

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

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { pack } = await req.json();
    if (!VALID_PACKS.includes(pack))
      return new Response(JSON.stringify({ error: "invalid pack" }), { status: 400, headers: CORS });

    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user)
      return new Response(JSON.stringify({ error: "not authenticated" }), { status: 401, headers: CORS });

    const { data: profile, error: profileErr } = await supabase
      .from("profiles").select("stripe_customer_id").eq("id", user.id).single();
    if (profileErr) throw new Error(`profile lookup failed: ${profileErr.message}`);

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      const { error: updErr } = await supabase
        .from("profiles").update({ stripe_customer_id: customerId }).eq("id", user.id);
      if (updErr) throw new Error(`failed to save stripe_customer_id: ${updErr.message}`);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "setup",
      payment_method_types: ["card"],
      success_url: "https://aethyro.com/app/dashboard.html?autotopup=success",
      cancel_url: "https://aethyro.com/app/dashboard.html?autotopup=cancelled",
      // stripe-webhook requires both to enable auto-topup on completion.
      metadata: {
        supabase_user_id: user.id,
        auto_topup_pack: pack,
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS });
  }
});
