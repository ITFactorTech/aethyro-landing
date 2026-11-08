// Provider-health circuit breaker, the OpenAI model map, and a failover wrapper
// for NON-STREAMING background jobs (run-routines, run-agent-task).
//
// Split out of _shared/llm.ts so these functions can use it without pulling
// llm.ts's Anthropic/OpenAI SDK imports into their bundles. llm.ts imports
// everything below from here (behavior unchanged).
//
// Circuit breaker: public.provider_health (provider text primary key,
// consecutive_failures int, opened_until timestamptz). A provider trips
// "open" after CIRCUIT_FAILURE_THRESHOLD consecutive failures and stays
// open (skipped entirely, no live retry) until opened_until passes -- a real
// outage only costs one slow failure per threshold-count of requests, not one
// per request.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

export type ModelKey = "haiku" | "sonnet" | "opus";
export type Provider = "anthropic" | "openai";

// OpenAI model per billing tier, chosen 2026-11-08 against OpenAI's own
// pricing page (developers.openai.com/api/docs/pricing, per 1M tokens in/out)
// so each OpenAI model costs no more than the Claude tier it is billed as:
//   haiku  -> gpt-6.1-terra  $1/$5    (Claude Haiku 4.5: $1/$5)
//   sonnet -> gpt-6.1-sol    $2/$10   (Claude Sonnet 5:   $2/$10)
//   opus   -> gpt-6.1-sol    $2/$10   (Claude Opus 5.5:   $4/$20 -- the Opus
//             tier stays on Sol rather than gpt-6-astra, $10/$50, which would
//             cost 2.5x what an Opus reply bills; Opus-tier failover is a
//             margin gain, as it was on gpt-5.4)
// The previous gpt-5.4 ($2.50/$15) was both a generation behind and slightly
// dearer than the Sonnet rate it was billed at. Never use a "-pro" model
// here: those 404 on Chat Completions (found live 2026-10-30). gpt-6-luna is
// deliberately NOT used for haiku: it is a reasoning model whose hidden
// reasoning tokens ate a 10-token budget completely (empty reply,
// finish_reason "length") when probed 2026-11-02.
export const OPENAI_MODEL_MAP: Record<ModelKey, string> = {
  haiku:  "gpt-6.1-terra",
  sonnet: "gpt-6.1-sol",
  opus:   "gpt-6.1-sol",
};

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 2 * 60 * 1000; // 2 minutes before the circuit lets a live Anthropic request through again

export async function isCircuitOpen(supaAdmin: SupabaseClient, provider: Provider): Promise<boolean> {
  const { data, error } = await supaAdmin
    .from("provider_health")
    .select("opened_until")
    .eq("provider", provider)
    .maybeSingle();
  if (error || !data?.opened_until) return false;
  return new Date(data.opened_until as string).getTime() > Date.now();
}

export async function recordFailure(supaAdmin: SupabaseClient, provider: Provider): Promise<void> {
  const { data } = await supaAdmin
    .from("provider_health")
    .select("consecutive_failures")
    .eq("provider", provider)
    .maybeSingle();
  const failures = ((data?.consecutive_failures as number) ?? 0) + 1;
  const opened_until = failures >= CIRCUIT_FAILURE_THRESHOLD
    ? new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString()
    : null;
  await supaAdmin.from("provider_health").upsert({ provider, consecutive_failures: failures, opened_until });
}

export async function recordSuccess(supaAdmin: SupabaseClient, provider: Provider): Promise<void> {
  await supaAdmin.from("provider_health").upsert({ provider, consecutive_failures: 0, opened_until: null });
}

// Runs `anthropic()`; if it throws (or the Anthropic circuit is open), runs
// `openai()` instead. For jobs with no client stream to un-send: if the
// Anthropic attempt got partway (a few tool rounds) and then threw, the
// OpenAI attempt restarts from scratch -- the caller's `openai` function must
// therefore reset any per-attempt state (token counters, collected results)
// itself. Whatever Anthropic burned before failing is absorbed, not billed.
// With no OpenAI key configured this is just `anthropic()`.
export async function runWithOpenAIFailover<T>(o: {
  supaAdmin: SupabaseClient;
  openaiApiKey: string | undefined;
  label: string;                 // for logs, e.g. "run-routines"
  anthropic: () => Promise<T>;
  openai: () => Promise<T>;
}): Promise<{ value: T; provider: Provider }> {
  if (!o.openaiApiKey) return { value: await o.anthropic(), provider: "anthropic" };

  if (!(await isCircuitOpen(o.supaAdmin, "anthropic"))) {
    try {
      const value = await o.anthropic();
      await recordSuccess(o.supaAdmin, "anthropic");
      return { value, provider: "anthropic" };
    } catch (err) {
      console.error(`${o.label}: anthropic failed, falling back to openai:`, err instanceof Error ? err.message : String(err));
      await recordFailure(o.supaAdmin, "anthropic");
    }
  } else {
    console.error(`${o.label}: anthropic circuit open, going straight to openai`);
  }

  try {
    const value = await o.openai();
    await recordSuccess(o.supaAdmin, "openai");
    return { value, provider: "openai" };
  } catch (err) {
    await recordFailure(o.supaAdmin, "openai");
    throw err;
  }
}
