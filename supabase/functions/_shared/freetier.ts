// Free-tier rule (2026-11-08): an account with no purchase -- its own or its
// team's -- runs on the cheapest tier only (Haiku billing rate, served by
// OpenAI gpt-6.1-terra). Sonnet and Opus are what a credit pack unlocks, and
// free usage never reaches the Anthropic account.
//
// "Purchased" = at least one credit_ledger row with reason='purchase' for the
// user, or for their team (team members spend a pooled balance someone else
// may have bought). Auto-top-up rows share that reason.
//
// Callers fail closed on an error: this returns { ok:false } and the caller
// decides (chat answers 503, background jobs skip the run), so a blip never
// hands a free account a paid tier.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

export async function hasPurchased(
  supaAdmin: SupabaseClient,
  userId: string,
  teamId: string | null | undefined,
): Promise<{ ok: true; purchased: boolean } | { ok: false; error: string }> {
  const filter = teamId ? `user_id.eq.${userId},team_id.eq.${teamId}` : `user_id.eq.${userId}`;
  const { data, error } = await supaAdmin
    .from("credit_ledger")
    .select("id")
    .eq("reason", "purchase")
    .or(filter)
    .limit(1);
  if (error) return { ok: false, error: error.message };
  return { ok: true, purchased: (data?.length ?? 0) > 0 };
}
