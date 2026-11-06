// auto-topup-charge — internal only, called by chat's finalize() via
// EdgeRuntime.waitUntil() fire-and-forget when a user with auto-topup
// enabled crosses the low-credit threshold. Creates a real off-session
// PaymentIntent against their saved default payment method for their
// chosen pack and grants credits directly once it actually succeeds. If that
// inline grant fails, stripe-webhook's payment_intent.succeeded handler is the
// durable recovery path (idempotent via the same ledger unique index).
//
// Pack cents/credits now imported from ../_shared/packs.ts, the single
// source of truth shared with buy-credits and setup-auto-topup — this
// charges a raw cents amount via PaymentIntent rather than reusing a Price
// ID, since Checkout (which needs a live customer session) isn't usable
// for an off-session charge, but the amount must still match the real
// Stripe Price exactly, which is why it comes from the same shared file.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";
import { CREDIT_PACKS } from "../_shared/packs.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-04-10" });
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Guards against two near-simultaneous chat requests both crossing the
// threshold and firing this before the first attempt's DB write lands.
const COOLDOWN_MS = 60 * 60 * 1000;

serve(async (req) => {
  if (req.headers.get("X-Internal-Key") !== SERVICE_ROLE_KEY)
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }
  const userId = body.user_id;
  if (!userId)
    return new Response(JSON.stringify({ error: "user_id required" }), { status: 400 });

  const { data: profile, error: profErr } = await supabase.from("profiles")
    .select("stripe_customer_id, stripe_payment_method_id, auto_topup_enabled, auto_topup_pack, auto_topup_last_attempt_at, team_id, monthly_spend_cap_credits")
    .eq("id", userId).single();
  if (profErr || !profile)
    return new Response(JSON.stringify({ skipped: "profile lookup failed" }));

  if (!profile.auto_topup_enabled || !profile.stripe_customer_id || !profile.stripe_payment_method_id)
    return new Response(JSON.stringify({ skipped: "not configured" }));

  // Monthly spend cap: do not auto-charge a user who has already hit it.
  if (typeof profile.monthly_spend_cap_credits === "number") {
    const { data: spentSoFar, error: spendErr } = await supabase.rpc("get_monthly_spend", { p_user_id: userId });
    // Fail closed (2026-11-06): get_monthly_spend() coalesces to a number, so an
    // error/non-number means the lookup failed. With a cap set, never create a
    // real off-session charge on an unverifiable spend figure -- skip instead.
    if (spendErr || typeof spentSoFar !== "number") {
      console.error("auto-topup-charge: monthly spend lookup failed", spendErr?.message ?? "non-numeric result");
      return new Response(JSON.stringify({ skipped: "monthly spend lookup failed" }), { status: 503 });
    }
    const spent = spentSoFar;
    if (spent >= profile.monthly_spend_cap_credits)
      return new Response(JSON.stringify({ skipped: "monthly spend cap reached" }));
  }

  const pack = CREDIT_PACKS[profile.auto_topup_pack ?? ""];
  if (!pack)
    return new Response(JSON.stringify({ skipped: "invalid pack" }));

  const lastAttempt = profile.auto_topup_last_attempt_at ? new Date(profile.auto_topup_last_attempt_at) : null;
  if (lastAttempt && lastAttempt.getTime() > Date.now() - COOLDOWN_MS)
    return new Response(JSON.stringify({ skipped: "cooldown" }));

  // Atomically CLAIM the attempt BEFORE charging (2026-11-06): one conditional
  // UPDATE whose WHERE re-checks the cooldown, so two near-simultaneous
  // invocations can't both pass the read above and both charge (the read-then-
  // write that used to be here was not atomic, and its write error was ignored).
  // Fail closed: no recorded claim -> no charge.
  const claimAt = new Date();
  const cutoffIso = new Date(claimAt.getTime() - COOLDOWN_MS).toISOString();
  const { data: claimed, error: claimErr } = await supabase.from("profiles")
    .update({ auto_topup_last_attempt_at: claimAt.toISOString() })
    .eq("id", userId)
    .or(`auto_topup_last_attempt_at.is.null,auto_topup_last_attempt_at.lt.${cutoffIso}`)
    .select("id");
  if (claimErr) {
    console.error("auto-topup-charge: attempt claim failed, not charging", claimErr.message);
    return new Response(JSON.stringify({ skipped: "attempt claim failed" }), { status: 503 });
  }
  if (!claimed || claimed.length === 0)
    return new Response(JSON.stringify({ skipped: "cooldown" }));

  try {
    // Stable idempotency key per claimed attempt: a retried/duplicated HTTP call
    // for the SAME attempt can never create a second PaymentIntent.
    const pi = await stripe.paymentIntents.create({
      amount: pack.cents,
      currency: "usd",
      customer: profile.stripe_customer_id,
      payment_method: profile.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: {
        supabase_user_id: userId,
        credit_pack: profile.auto_topup_pack,
        auto_topup: "true",
      },
    }, { idempotencyKey: `autotopup:${userId}:${claimAt.toISOString()}` });

    if (pi.status !== "succeeded") {
      return new Response(JSON.stringify({ ok: false, status: pi.status }));
    }

    // Reuses credit_ledger's existing partial unique index on
    // stripe_session_id WHERE reason = 'purchase' — a PaymentIntent id
    // (pi_...) is a distinct namespace from Checkout Session ids (cs_...),
    // so it can never collide with a real Checkout-driven purchase row.
    const { error: ledgerErr } = await supabase.from("credit_ledger").insert({
      user_id: userId,
      delta: pack.credits,
      reason: "purchase",
      stripe_session_id: pi.id,
      team_id: profile.team_id ?? null,
      metadata: { credit_pack: profile.auto_topup_pack, amount_total: pack.cents, auto_topup: true },
    });
    if (ledgerErr && ledgerErr.code !== "23505") {
      // The card WAS charged. Do not charge again; the stripe-webhook
      // payment_intent.succeeded handler re-grants idempotently (same unique
      // index) and Stripe retries it until it succeeds. 503 (not the old 200) so
      // this is visible in edge logs / error scans.
      console.error("auto-topup credit_ledger insert failed AFTER CHARGE (webhook will recover)", { payment_intent: pi.id, message: ledgerErr.message });
      return new Response(JSON.stringify({ ok: false, error: "credit grant failed after charge", payment_intent: pi.id }), { status: 503 });
    }

    return new Response(JSON.stringify({ ok: true, credits: pack.credits }));
  } catch (e) {
    // Card declined, authentication_required (SCA), expired card, etc. —
    // disable auto-topup rather than retry-looping on every future
    // low-balance message. The existing low-credit email still fires
    // normally as a fallback so the user isn't left with no signal at all.
    await supabase.from("profiles").update({ auto_topup_enabled: false }).eq("id", userId);
    console.error("auto-topup charge failed, disabled", (e as Error).message);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }));
  }
});
