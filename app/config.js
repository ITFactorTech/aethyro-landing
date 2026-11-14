// Aethyro app config — PUBLIC values (safe in the browser). RLS protects data.
(function () {
  // Cloudflare Turnstile SITE key (public). Empty = no human check on the email signup
  // form. Fill it in only together with the TURNSTILE_SECRET_KEY secret and the
  // "Before User Created" auth hook (see supabase/functions/signup-gate/index.ts).
  window.AETHYRO_TURNSTILE_SITEKEY = "0x4AAAAAAE-DbNg5b5LjP-2J";
  var SUPABASE_URL  = "https://uzmdqbtflcpikjdrggqc.supabase.co";
  var SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6bWRxYnRmbGNwaWtqZHJnZ3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODQxOTgsImV4cCI6MjA5MTI2MDE5OH0.BwNVBJCbw9SG-ge7PfmoIW8q_33k-ZQlqpDHa2HrvHI";
  if (!window.supabase || !window.supabase.createClient) {
    window.AETHYRO_LOADERR = "supabase library failed to load (vendor/supabase.js)";
    return;
  }
  // Exposed for direct fetch() calls to edge functions that stream their
  // response body (e.g. /chat) — supabase.functions.invoke() buffers the
  // whole response, so streaming callers need the raw URL + anon key instead.
  window.AETHYRO_FN_URL = SUPABASE_URL + "/functions/v1";
  window.AETHYRO_ANON_KEY = SUPABASE_ANON;
  // Aethyro Cloud sells one-time credit packs only — there are no subscription
  // tiers. Purchases go through the buy-credits edge function, which stamps the
  // user id into the Stripe session; never put checkout links here.
  window.AETHYRO = {
    supabase: window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON),
  };
})();
