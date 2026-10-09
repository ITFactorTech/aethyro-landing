// buy-credits v17 — logs every real purchase-funnel attempt (once we know
// who the user is and which pack they picked) to purchase_funnel_events,
// so a future session can tell "nobody ever reaches checkout" apart from
// "people reach checkout and abandon at Stripe" purely from Supabase data
// -- this project has had $0 lifetime revenue across 51 signups with no
// way to distinguish those two cases (GA4's checkout_started event isn't
// queryable here, and Stripe itself isn't connected in this session).
// Logging is deliberately best-effort/fire-and-forget: a logging failure
// must never block or alter the real checkout flow.
// buy-credits v16 — pack prices/credits now imported from
// ../_shared/packs.ts, the single source of truth shared with
// auto-topup-charge and setup-auto-topup (and, for display, pack-config.js
// on the frontend). No more locally-duplicated CREDIT_PACKS literal.
// buy-credits v15 — CORS was a bare "*", letting any website make
// authenticated cross-origin calls against this billed endpoint. Locked to
// aethyro.com (+ this project's Cloudflare preview subdomains) via a
// per-request origin check — see chat/index.ts v48's comment for the same
// fix and why it's defense-in-depth rather than a response to a live
// exploit.
// buy-credits v14 — creates a Stripe Checkout Session for a one-time credit pack.
//
// This is the ONLY supported purchase path. Raw Stripe Payment Link URLs must
// not be used from the frontend: a Payment Link checkout carries no
// supabase_user_id, so stripe-webhook cannot attribute the payment to an
// account and the buyer is charged without receiving credits.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import { CREDIT_PACKS } from "../_shared/packs.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-04-10" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

// Best-effort only -- never let a logging failure affect the real checkout
// response. Logs only once we know both a real user and a real pack (an
// invalid pack or an expired/missing session isn't a real funnel attempt).
async function logFunnelEvent(fields: {
  userId: string;
  pack: string;
  outcome: "success" | "error";
  stripeSessionId?: string;
  errorMessage?: string;
}) {
  try {
    await supabase.from("purchase_funnel_events").insert({
      user_id: fields.userId,
      pack: fields.pack,
      outcome: fields.outcome,
      stripe_session_id: fields.stripeSessionId ?? null,
      error_message: fields.errorMessage ?? null,
    });
  } catch (_e) {
    // swallow -- diagnostic logging must never break a real purchase
  }
}

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { pack } = await req.json();
    const selected = CREDIT_PACKS[pack];
    if (!selected)
      return new Response(JSON.stringify({ error: "invalid pack" }), { status: 400, headers: CORS });

    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user)
      return new Response(JSON.stringify({ error: "not authenticated" }), { status: 401, headers: CORS });

    // From here on we have a real signed-in user attempting a real pack --
    // this is the actual purchase funnel moment worth logging.
    try {
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
        mode: "payment",
        line_items: [{ price: selected.priceId, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: "https://aethyro.com/app/chat.html?purchase=success",
        cancel_url: "https://aethyro.com/app/chat.html?purchase=cancelled",
        // stripe-webhook requires all three to credit the account.
        metadata: {
          supabase_user_id: user.id,
          credit_pack: pack,
          credits: String(selected.credits),
        },
      });

      await logFunnelEvent({ userId: user.id, pack, outcome: "success", stripeSessionId: session.id });

      return new Response(JSON.stringify({ url: session.url }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    } catch (innerErr) {
      await logFunnelEvent({
        userId: user.id,
        pack,
        outcome: "error",
        errorMessage: (innerErr as Error).message,
      });
      throw innerErr;
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS });
  }
});
