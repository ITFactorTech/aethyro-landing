// Decommissioned 2026-09-27: this powered Aethyro's old per-plan subscription
// model ($29-$499/mo), which was abandoned in favor of one-time credit packs
// (see /app/chat.html?buy=<pack> -> buy-credits). Left unlinked, this endpoint
// could still create real, live Stripe subscription charges for a product with
// no entitlement logic behind it. Stubbed to refuse instead of deleted, so any
// stray caller gets a clean, safe error rather than a real charge.

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

Deno.serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  return new Response(
    JSON.stringify({ error: "This checkout flow has been discontinued. Buy credits at https://aethyro.com/app/chat.html" }),
    { status: 410, headers: { ...CORS, "Content-Type": "application/json" } },
  );
});
