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

// The breaker keys are free text: besides the two providers, the free-tier
// chain (below) keeps one row per model step ("openai:terra", "openai:luna"),
// created on first write. A provider-wide row cannot tell "Terra is down" from
// "OpenAI is down", and the chain's second step is a different OpenAI model.
export async function isCircuitOpen(supaAdmin: SupabaseClient, provider: string): Promise<boolean> {
  const { data, error } = await supaAdmin
    .from("provider_health")
    .select("opened_until")
    .eq("provider", provider)
    .maybeSingle();
  if (error || !data?.opened_until) return false;
  return new Date(data.opened_until as string).getTime() > Date.now();
}

export async function recordFailure(supaAdmin: SupabaseClient, provider: string): Promise<void> {
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

export async function recordSuccess(supaAdmin: SupabaseClient, provider: string): Promise<void> {
  await supaAdmin.from("provider_health").upsert({ provider, consecutive_failures: 0, opened_until: null });
}

// ── Free-tier failsafe chain ─────────────────────────────────────────────────
// A free account (no purchase, see freetier.ts) is served on the Haiku billing
// rate by a chain of providers instead of a single one:
//   1. OpenAI gpt-6.1-terra   (primary; gets the web tools)
//   2. OpenAI gpt-6-luna      (reasoning_effort "none"; ~10x cheaper than Terra;
//                              plain completion, no tools)
//   3. Anthropic Haiku        (last resort; only while the Anthropic circuit is
//                              closed, and only if the flag below is true)
// The user pays the same Haiku rate whichever step answers (billing is keyed to
// the tier, never the provider), so every step below the first is a cost gain
// or neutral for Aethyro. Luna's effort must stay "none": left to its default it
// spends hidden reasoning tokens (13-44 on a one-line prompt, 2026-11-10 probe)
// and ate a 10-token budget completely on 2026-11-02.
export const FREE_TIER_LUNA_MODEL = "gpt-6-luna";
// true: Anthropic Haiku is the last resort when both OpenAI steps fail (the
// "usage cost always has a backup" ask). false: free usage never reaches the
// Anthropic account, at the price of failing when OpenAI is entirely down.
export const FREE_TIER_ANTHROPIC_LAST_RESORT = true;
// A step that has produced no answer text within this long is abandoned for the
// next one (a hung connection is a failure too, not just an error response).
export const FREE_TIER_FIRST_RESPONSE_MS = 25_000;
export const FREE_CHAIN_KEYS = { terra: "openai:terra", luna: "openai:luna", haiku: "anthropic" } as const;

export interface ChainStep<R> {
  key: string;                 // provider_health row for this step's circuit breaker
  label: string;               // for logs
  run: () => Promise<R>;
  // true => the step returned but delivered nothing usable (empty reply): counted
  // as a failure and the next step runs. Never consulted once output has streamed.
  isEmpty?: (r: R) => boolean;
}

// Runs the steps in order until one answers. Pure orchestration (no SDK
// imports) so it can be exercised with stubs.
//  - A step whose breaker is open is skipped, unless EVERY step's is open, in
//    which case none is skipped: a chain that gives up without trying anything
//    is the one outcome this exists to prevent.
//  - A throw or an empty reply records a failure against that step's breaker
//    and moves on. A success resets it.
//  - Once `emittedOutput()` is true a failing step is re-thrown instead: bytes
//    already reached the caller, and a later step would stream a second,
//    complete reply on top of the truncated first.
export async function runChain<R>(o: {
  supaAdmin: SupabaseClient;
  label: string;
  steps: ChainStep<R>[];
  emittedOutput: () => boolean;
}): Promise<{ value: R; stepKey: string; attempts: string[] }> {
  if (o.steps.length === 0) throw new Error(`${o.label}: no providers configured`);
  const open = await Promise.all(o.steps.map((s) => isCircuitOpen(o.supaAdmin, s.key)));
  const skipAll = open.every(Boolean);
  const attempts: string[] = [];
  let lastErr: unknown = null;

  for (let i = 0; i < o.steps.length; i++) {
    const step = o.steps[i];
    if (open[i] && !skipAll) {
      attempts.push(`${step.label}:skipped(circuit open)`);
      continue;
    }
    try {
      const value = await step.run();
      if (!o.emittedOutput() && step.isEmpty?.(value)) {
        attempts.push(`${step.label}:empty`);
        lastErr = new Error(`${step.label} returned an empty reply`);
        await recordFailure(o.supaAdmin, step.key);
        continue;
      }
      await recordSuccess(o.supaAdmin, step.key);
      attempts.push(`${step.label}:ok`);
      if (attempts.length > 1) console.error(`${o.label}: answered by ${step.label} after [${attempts.join(", ")}]`);
      return { value, stepKey: step.key, attempts };
    } catch (err) {
      lastErr = err;
      attempts.push(`${step.label}:error`);
      console.error(`${o.label}: ${step.label} failed:`, err instanceof Error ? err.message : String(err));
      await recordFailure(o.supaAdmin, step.key);
      if (o.emittedOutput()) {
        console.error(`${o.label}: ${step.label} had already streamed output -- not trying the next step (would duplicate the reply)`);
        throw err;
      }
    }
  }
  const e = new Error(`${o.label}: every provider failed [${attempts.join(", ")}]`);
  (e as any).cause = lastErr;
  throw e;
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
  // Free-tier accounts never reach the Anthropic account (see freetier.ts):
  // when true, go straight to OpenAI without touching the circuit breaker.
  forceOpenAI?: boolean;
  anthropic: () => Promise<T>;
  openai: () => Promise<T>;
}): Promise<{ value: T; provider: Provider }> {
  if (o.forceOpenAI && !o.openaiApiKey) throw new Error("OpenAI is not configured.");
  if (!o.openaiApiKey) return { value: await o.anthropic(), provider: "anthropic" };

  if (o.forceOpenAI) {
    // straight to OpenAI below
  } else if (!(await isCircuitOpen(o.supaAdmin, "anthropic"))) {
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
