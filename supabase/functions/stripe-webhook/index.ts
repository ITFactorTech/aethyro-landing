import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-04-10" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// stripe_customer_id lives on `profiles` (unique), NOT on `subscriptions`.
// subscriptions columns: user_id, plan, status, trial_ends_at, current_period_end,
// stripe_subscription_id, stripe_price_id, created_at, updated_at.
// status constraint: trialing | active | past_due | canceled | expired  (one 'l')

// Grant the credits a one-time pack session paid for.
//
// Safe to call more than once for the same session: credit_ledger has a partial
// unique index on stripe_session_id WHERE reason = 'purchase', so a duplicate
// webhook delivery (or both checkout.session.completed and
// async_payment_succeeded firing) raises 23505 and is swallowed here.
async function grantPackCredits(s: Stripe.Checkout.Session) {
  const userId = s.metadata?.supabase_user_id;
  const credits = parseInt(s.metadata?.credits ?? "0", 10);
  if (!userId || !(credits > 0)) {
    console.error("credit pack session missing user or credits", {
      session: s.id,
      has_user: !!userId,
      credits: s.metadata?.credits,
    });
    return;
  }

  const { error } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    delta: credits,
    reason: "purchase",
    stripe_session_id: s.id,
    metadata: { credit_pack: s.metadata?.credit_pack, amount_total: s.amount_total },
  });
  // 23505 = unique_violation (duplicate delivery) — idempotent, not an error
  if (error && error.code !== "23505") {
    console.error("credit_ledger insert failed", error.message);
  }
}

serve(async (req) => {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    return new Response(`Webhook error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      // Klarna, Cash App and other delayed-notification methods complete the
      // session before the money settles: checkout.session.completed arrives
      // with payment_status 'unpaid' and the payment can still fail. Only grant
      // once it has actually settled; the async_payment_* events below carry
      // the real outcome for those.
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === "payment" && s.metadata?.credit_pack) await grantPackCredits(s);
        break;
      }

      case "checkout.session.async_payment_failed": {
        const s = event.data.object as Stripe.Checkout.Session;
        // Nothing to undo — no credits were granted while it was pending.
        console.error("async payment failed, no credits granted", { session: s.id });
        break;
      }

      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.metadata?.supabase_user_id;

        // One-time credit-pack purchase
        if (s.mode === "payment" && s.metadata?.credit_pack) {
          const settled = s.payment_status === "paid" || s.payment_status === "no_payment_required";
          if (settled) await grantPackCredits(s);
          else console.log("credit pack payment pending, awaiting async result", {
            session: s.id, payment_status: s.payment_status,
          });
          break;
        }

        // Subscription checkout
        const plan = s.metadata?.plan || "personal";
        if (userId && s.customer) {
          const { error: profErr } = await supabase.from("profiles")
            .update({ stripe_customer_id: s.customer as string }).eq("id", userId);
          if (profErr) console.error("profiles update failed", profErr.message);

          const { error: subErr } = await supabase.from("subscriptions").upsert({
            user_id: userId,
            stripe_subscription_id: s.subscription as string,
            plan,
            status: "active",
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" });
          if (subErr) console.error("subscriptions upsert failed", subErr.message);
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object as Stripe.Subscription;
        const { data: profile, error: lookupErr } = await supabase.from("profiles")
          .select("id").eq("stripe_customer_id", sub.customer as string).single();
        if (lookupErr) { console.error("profile lookup failed", lookupErr.message); break; }
        if (profile) {
          // Map Stripe statuses to our DB constraint values
          const statusMap: Record<string, string> = {
            trialing: "trialing",
            active: "active",
            past_due: "past_due",
            canceled: "canceled",
            cancelled: "canceled",  // Stripe sends both spellings
            incomplete_expired: "expired",
            unpaid: "past_due",
          };
          const dbStatus = statusMap[sub.status] ?? "active";
          const { error: updErr } = await supabase.from("subscriptions").update({
            stripe_subscription_id: sub.id,
            stripe_price_id: sub.items?.data?.[0]?.price?.id ?? null,
            status: dbStatus,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("user_id", profile.id);
          if (updErr) console.error("subscriptions update failed", updErr.message);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const { error: delErr } = await supabase.from("subscriptions").update({
          status: "canceled",  // one 'l' — matches DB check constraint
          updated_at: new Date().toISOString(),
        }).eq("stripe_subscription_id", sub.id);
        if (delErr) console.error("subscriptions cancel update failed", delErr.message);
        break;
      }
    }
  } catch (err) {
    console.error("webhook handler error", err.message);
    // Always 200 back to Stripe — a handler bug shouldn't cause infinite retries
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
