// Decommissioned 2026-09-27: this powered Aethyro's old per-plan subscription
// model ($29-$499/mo), which was abandoned in favor of one-time credit packs
// (see /app/chat.html?buy=<pack> -> buy-credits). Left unlinked, this endpoint
// could still create real, live Stripe subscription charges for a product with
// no entitlement logic behind it. Stubbed to refuse instead of deleted, so any
// stray caller gets a clean, safe error rather than a real charge.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  return new Response(
    JSON.stringify({ error: "This checkout flow has been discontinued. Buy credits at https://aethyro.com/app/chat.html" }),
    { status: 410, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
