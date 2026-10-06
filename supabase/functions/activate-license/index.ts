// Decommissioned 2026-09-27: part of the abandoned GH05T3 desktop-app
// licensing backend. Confirmed dead: 0 rows ever in `licenses`, 0 real
// paid subscriptions in Stripe for any of its plans. Stubbed to refuse
// instead of deleted, so any stray caller gets a clean error rather than
// a real (if currently unreachable) entitlement check.

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(
    JSON.stringify({ entitled: false, reason: "This service has been discontinued." }),
    { status: 410, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
