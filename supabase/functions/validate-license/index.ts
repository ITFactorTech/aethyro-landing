// Decommissioned 2026-09-27: part of the abandoned GH05T3 desktop-app
// licensing backend. Confirmed dead: 0 licenses were ever issued, so no
// device anywhere holds a token this would need to re-validate. Stubbed
// to refuse instead of deleted, so any stray caller gets a clean error
// rather than a real signature-verification attempt. verify_jwt stays
// false, matching the original (the desktop app calls this without a
// Supabase session, just the license token itself).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(
    JSON.stringify({ valid: false, reason: "This service has been discontinued." }),
    { status: 410, headers: { ...cors, "Content-Type": "application/json" } },
  );
});
