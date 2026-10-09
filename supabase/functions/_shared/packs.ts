// Single source of truth for credit-pack pricing, used by every edge
// function that needs to know what a pack costs or how many credits it
// grants: buy-credits (real Checkout Session), auto-topup-charge (off-session
// PaymentIntent, needs cents directly since it can't reuse a Price ID),
// setup-auto-topup (just needs the valid key list).
//
// Keep this in sync with /pack-config.js (the frontend's own copy, used for
// display only -- it has no access to priceId, which is server-only). A CI
// check compares the two on every PR; see
// .github/workflows/pack-config-check.yml.
//
// priceId values are real, live Stripe Price ids -- if a price is ever
// changed in Stripe, a new Price object must be created (Stripe Prices are
// immutable) and this file updated to point at it.
export interface CreditPack {
  priceId: string;
  credits: number;
  cents: number;
}

export const CREDIT_PACKS: Record<string, CreditPack> = {
  starter: { priceId: "price_1UJDr4LSbMeMK2S0BwCPsiq0", credits: 200, cents: 400 },
  value: { priceId: "price_1UJDr6LSbMeMK2S0WhJstVjM", credits: 600, cents: 1000 },
  power: { priceId: "price_1UJDr9LSbMeMK2S0VPdF6Roa", credits: 2000, cents: 3000 },
  pro_7k: { priceId: "price_1UJDrBLSbMeMK2S0vhpUVXCw", credits: 7000, cents: 9000 },
};
