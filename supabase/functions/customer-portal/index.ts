// Decommissioned 2026-09-27: served Stripe's billing portal for the
// abandoned per-plan subscription model (see create-checkout). Stubbed to
// refuse instead of deleted, so any stray caller gets a clean error
// rather than a real Stripe billing-portal session.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  return new Response(
    JSON.stringify({ error: "This service has been discontinued." }),
    { status: 410, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
