import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import { CREDIT_PACKS } from "../_shared/packs.ts";

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

// Postgres errors that can never succeed on retry (user deleted -> FK 23503,
// CHECK 23514, NOT NULL 23502, data exceptions 22xxx). Everything else
// (connection failures carry no code; 40001, 57014, 5xx, ...) is treated as
// transient so Stripe retries the delivery.
function isPermanentDbError(code?: string | null): boolean {
  return !!code && (code === "23503" || code === "23514" || code === "23502" || code.startsWith("22"));
}

// Insert one purchase ledger row for money Stripe has actually settled.
//
// Safe to call more than once for the same Stripe id: credit_ledger has a
// partial unique index on stripe_session_id WHERE reason = 'purchase', so a
// duplicate delivery (or the inline auto-topup grant racing this recovery
// path) raises 23505 and is treated as success.
//
// Retry semantics (2026-11-06): a TRANSIENT failure (buyer lookup or ledger
// insert) now THROWS so the handler returns 500 and Stripe re-delivers for
// days, instead of being swallowed and 200'd -- previously a paid purchase
// whose insert failed once was silently lost. PERMANENT problems (buyer
// profile gone, constraint violation) are logged loudly for manual review and
// return normally (200): retrying them forever can never help and would get
// the endpoint auto-disabled by Stripe.
async function grantCredits(opts: {
  userId: string; credits: number; stripeId: string; metadata: Record<string, unknown>;
}) {
  // Stamp the buyer's current team, if any, so a purchase by any team
  // member feeds the shared pool get_credit_balance() understands.
  const { data: buyer, error: buyerErr } = await supabase.from("profiles")
    .select("team_id").eq("id", opts.userId).single();
  if (buyerErr) {
    if (buyerErr.code === "PGRST116") { // zero rows: buyer deleted their account
      console.error("PAID but cannot credit: buyer profile not found (manual review needed)", {
        stripe_id: opts.stripeId, user: opts.userId, credits: opts.credits,
      });
      return;
    }
    throw new Error(`buyer profile lookup failed for ${opts.stripeId}: ${buyerErr.message}`);
  }

  const { error } = await supabase.from("credit_ledger").insert({
    user_id: opts.userId,
    delta: opts.credits,
    reason: "purchase",
    stripe_session_id: opts.stripeId,
    team_id: buyer?.team_id ?? null,
    metadata: opts.metadata,
  });
  // 23505 = unique_violation (duplicate delivery) — idempotent, not an error
  if (!error || error.code === "23505") return;
  if (isPermanentDbError(error.code)) {
    console.error("PAID but credit grant permanently failed (manual review needed)", {
      stripe_id: opts.stripeId, user: opts.userId, credits: opts.credits, code: error.code, message: error.message,
    });
    return;
  }
  throw new Error(`credit grant failed for ${opts.stripeId}: ${error.message}`);
}

// Grant the credits a one-time pack Checkout session paid for.
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
  await grantCredits({
    userId, credits, stripeId: s.id,
    metadata: { credit_pack: s.metadata?.credit_pack, amount_total: s.amount_total },
  });
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

      // Recovery path for auto-topup charges (auto-topup-charge/index.ts). That
      // function grants inline right after a successful off-session charge; if
      // the inline grant fails (or the PaymentIntent settles later, e.g.
      // status 'processing'), THIS event is the durable retry -- Stripe
      // re-delivers until it returns 2xx. Idempotent against the inline grant via
      // the same unique index (stripe_session_id = the pi_ id). Only auto-topup
      // PaymentIntents (metadata.auto_topup) are handled: Checkout-created
      // PaymentIntents are credited through their session events above and must
      // not be double-granted here. Requires the Stripe webhook endpoint to be
      // subscribed to payment_intent.succeeded (Dashboard > Developers > Webhooks).
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.auto_topup !== "true") break;
        const userId = pi.metadata?.supabase_user_id;
        const packKey = pi.metadata?.credit_pack ?? "";
        const pack = CREDIT_PACKS[packKey];
        if (!userId || !pack || pi.amount_received !== pack.cents) {
          console.error("auto-topup PaymentIntent cannot be credited (manual review needed)", {
            payment_intent: pi.id, has_user: !!userId, pack: packKey, amount_received: pi.amount_received,
          });
          break;
        }
        await grantCredits({
          userId, credits: pack.credits, stripeId: pi.id,
          metadata: { credit_pack: packKey, amount_total: pack.cents, auto_topup: true },
        });
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

        // Auto-topup card setup (setup-auto-topup/index.ts) — save the
        // confirmed payment method as the customer's default and flip
        // auto_topup_enabled on. Nothing is charged here.
        if (s.mode === "setup" && userId) {
          const setupIntentId = s.setup_intent as string | null;
          if (!setupIntentId) { console.error("setup session missing setup_intent", { session: s.id }); break; }
          const si = await stripe.setupIntents.retrieve(setupIntentId);
          const pmId = si.payment_method as string | null;
          if (!pmId || !s.customer) { console.error("setup session missing payment_method/customer", { session: s.id }); break; }

          await stripe.customers.update(s.customer as string, {
            invoice_settings: { default_payment_method: pmId },
          });

          const { error: autoErr } = await supabase.from("profiles").update({
            stripe_payment_method_id: pmId,
            auto_topup_enabled: true,
            auto_topup_pack: s.metadata?.auto_topup_pack ?? null,
          }).eq("id", userId);
          if (autoErr) console.error("auto-topup profile update failed", autoErr.message);
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
    // 500 so Stripe re-delivers (exponential backoff, up to ~3 days). Permanent,
    // known-unrecoverable cases are handled inside the handlers and return 200
    // (see grantCredits) -- only unexpected/transient failures reach here.
    console.error("webhook handler error (returning 500 so Stripe retries)", (err as Error).message);
    return new Response("Webhook processing failed", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
