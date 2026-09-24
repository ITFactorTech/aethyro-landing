// smoke_test.ts — integration smoke tests for Aethyro edge function logic
// Run with: deno test --allow-all supabase/functions/_tests/smoke_test.ts

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";

// ── chunkText (mirrors embed-content logic) ───────────────────────────────────

function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end).trim());
    start += chunkSize - overlap;
  }
  return chunks.filter(c => c.length > 20);
}

Deno.test("chunkText: short text yields one chunk", () => {
  const chunks = chunkText("Hello world, this is a test document.");
  assertEquals(chunks.length, 1);
});

Deno.test("chunkText: text longer than chunkSize yields multiple chunks", () => {
  const longText = "A".repeat(1800);
  const chunks = chunkText(longText);
  assertEquals(chunks.length, 3); // 0-800, 700-1500, 1400-1800
});

Deno.test("chunkText: chunks overlap by 100 characters", () => {
  const text = "B".repeat(900);
  const chunks = chunkText(text);
  assertEquals(chunks.length, 2);
  // Second chunk starts at 700 (800 - 100 overlap)
  assertEquals(chunks[1].length, 200);
});

Deno.test("chunkText: filters chunks shorter than 20 chars", () => {
  const text = "A".repeat(820) + "   ";
  const chunks = chunkText(text);
  // Last chunk "   ".trim() is empty → filtered
  assert(chunks.every(c => c.length > 20));
});

// ── EXECUTOR_MODEL_MAP (mirrors run-agent-task logic) ─────────────────────────

const EXECUTOR_MODEL_MAP: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
};

Deno.test("model key mapping: haiku resolves correctly", () => {
  assertEquals(EXECUTOR_MODEL_MAP["haiku"], "claude-haiku-4-5-20251001");
});

Deno.test("model key mapping: unknown key falls back to haiku", () => {
  const modelKey = "unknown";
  const model = EXECUTOR_MODEL_MAP[modelKey] || EXECUTOR_MODEL_MAP.haiku;
  assertEquals(model, "claude-haiku-4-5-20251001");
});

Deno.test("model key mapping: all keys present", () => {
  for (const key of ["haiku", "sonnet", "opus"]) {
    assertExists(EXECUTOR_MODEL_MAP[key], `Missing model key: ${key}`);
  }
});

// ── CORS headers ──────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.test("CORS: preflight response headers are correct", () => {
  const resp = new Response("ok", { headers: CORS });
  assertEquals(resp.headers.get("Access-Control-Allow-Origin"), "*");
  assert(resp.headers.get("Access-Control-Allow-Headers")!.includes("authorization"));
});

// ── embed-content: search type branching ─────────────────────────────────────

function resolveSearchRpc(source: string): string {
  if (source === "documents") return "match_document_chunks";
  return "match_memory_embeddings";
}

Deno.test("search RPC: documents source resolves to match_document_chunks", () => {
  assertEquals(resolveSearchRpc("documents"), "match_document_chunks");
});

Deno.test("search RPC: memory source resolves to match_memory_embeddings", () => {
  assertEquals(resolveSearchRpc("memory"), "match_memory_embeddings");
});

Deno.test("search RPC: unknown source defaults to match_memory_embeddings", () => {
  assertEquals(resolveSearchRpc(""), "match_memory_embeddings");
  assertEquals(resolveSearchRpc("anything"), "match_memory_embeddings");
});

// ── credit cost calculation ───────────────────────────────────────────────────

const CREDIT_RATES: Record<string, { input: number; output: number }> = {
  haiku:  { input: 0.08,  output: 0.40  },
  sonnet: { input: 0.30,  output: 1.50  },
  opus:   { input: 1.50,  output: 7.50  },
};

function calcCost(modelKey: string, inputTokens: number, outputTokens: number): number {
  const rates = CREDIT_RATES[modelKey] || CREDIT_RATES.haiku;
  return Math.max(10, Math.ceil((inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output));
}

Deno.test("credit cost: minimum is 10 credits", () => {
  assertEquals(calcCost("haiku", 10, 10), 10);
});

Deno.test("credit cost: haiku 1k in + 1k out = 1 credit (rounds up, min 10)", () => {
  const cost = calcCost("haiku", 1000, 1000);
  assertEquals(cost, 10); // 0.08 + 0.40 = 0.48 → ceil=1, but min=10
});

Deno.test("credit cost: opus 100k in + 10k out = well above minimum", () => {
  const cost = calcCost("opus", 100000, 10000);
  // (100 * 1.50) + (10 * 7.50) = 150 + 75 = 225
  assertEquals(cost, 225);
});

Deno.test("credit cost: unknown model defaults to haiku rates", () => {
  const cost = calcCost("unknown", 1000, 1000);
  assertEquals(cost, 10); // same as haiku minimum
});

// ── plan JSON parsing (mirrors run-agent-task planner) ────────────────────────

function parsePlan(raw: string, maxSteps: number): string[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]).slice(0, maxSteps); } catch { /* fall through */ }
  }
  return [];
}

Deno.test("parsePlan: valid JSON array extracted from prose", () => {
  const raw = 'Here is the plan: ["Step 1", "Step 2", "Step 3"] as requested.';
  const plan = parsePlan(raw, 6);
  assertEquals(plan, ["Step 1", "Step 2", "Step 3"]);
});

Deno.test("parsePlan: respects maxSteps limit", () => {
  const raw = '["A","B","C","D","E","F","G","H"]';
  const plan = parsePlan(raw, 6);
  assertEquals(plan.length, 6);
});

Deno.test("parsePlan: returns empty array for malformed JSON", () => {
  const plan = parsePlan("No array here.", 6);
  assertEquals(plan, []);
});

Deno.test("parsePlan: returns empty array for empty response", () => {
  assertEquals(parsePlan("", 6), []);
});
