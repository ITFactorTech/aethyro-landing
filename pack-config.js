// Single source of truth for credit-pack display data (label/price/credits),
// loaded by index.html, pricing.html, and app/dashboard.html so pack names
// and numbers can't silently drift between pages the way the Pro/Power swap
// (fixed in PR #149) and the Value/Standard naming split (fixed alongside
// this file) both did.
//
// Mirrors supabase/functions/_shared/packs.ts (the real Stripe-backed
// source -- this file has no priceId, since that's server-only). A CI check
// compares the two on every PR; see .github/workflows/pack-config-check.yml.
// If you change a price or credit amount here, it must also change there
// (and a new Stripe Price must exist, since Stripe Prices are immutable).
window.AETHYRO_PACKS = [
  { key: "starter", label: "Starter", price: 4, credits: 200, note: "try it out" },
  { key: "value", label: "Standard", price: 10, credits: 600, note: "regular users" },
  { key: "power", label: "Power", price: 30, credits: 2000, note: "heavy users" },
  { key: "pro_7k", label: "Pro", price: 90, credits: 7000, note: "teams & professionals" },
];
