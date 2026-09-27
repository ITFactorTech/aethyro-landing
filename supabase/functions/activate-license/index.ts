// Decommissioned 2026-09-27: part of the abandoned GH05T3 desktop-app
// licensing backend. Confirmed dead: 0 rows ever in `licenses`, 0 real
// paid subscriptions in Stripe for any of its plans. Stubbed to refuse
// instead of deleted, so any stray caller gets a clean error rather than
// a real (if currently unreachable) entitlement check.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(
    JSON.stringify({ entitled: false, reason: "This service has been discontinued." }),
    { status: 410, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
