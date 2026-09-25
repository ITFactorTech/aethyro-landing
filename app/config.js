// Aethyro app config — PUBLIC values (safe in the browser). RLS protects data.
(function () {
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
  window.AETHYRO = {
    supabase: window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON),
    // Retired subscription tiers. Aethyro Cloud sells one-time credit packs
    // only — these remain solely to label legacy `subscriptions` rows on the
    // dashboard. Do not re-add checkout links here.
    PLANS: {
      personal: { label: "Personal" },
      research: { label: "Research" },
      dev:      { label: "Developer" },
      cpa:      { label: "Professional" },
    },
  };
})();
