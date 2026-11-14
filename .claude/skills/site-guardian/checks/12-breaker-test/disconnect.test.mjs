// Run: node --experimental-strip-types disconnect.test.mjs <path-to-failover.ts>
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.argv[2]).href);
const { runChain, isCircuitOpen } = mod;
const isClientDisconnect = mod.isClientDisconnect;

function stub(rows = {}) {
  const db = { ...rows };
  return { db, from() { let val = null; return {
    select() { return this; }, eq(c, v) { val = v; return this; },
    async maybeSingle() { return { data: db[val] ?? null, error: null }; },
    async upsert(row) { db[row.provider] = { consecutive_failures: row.consecutive_failures, opened_until: row.opened_until }; return { error: null }; },
  }; } };
}
console.error = () => {};
let n = 0, failed = 0;
async function t(name, fn) { try { await fn(); n++; console.log(`ok ${n} - ${name}`); } catch (e) { failed++; console.log(`FAIL - ${name}: ${e.message.split("\n")[0]}`); } }
const step = (key, run) => ({ key, label: key, run });
const disconnect = () => { const e = new TypeError("The stream controller cannot close or enqueue"); (e).code = "ERR_INVALID_STATE"; return e; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

await t("a client disconnect after output streamed is re-thrown and NOT counted against the step", async () => {
  const s = stub(); let ran2 = false;
  const e = await rejects(runChain({ supaAdmin: s, label: "t", emittedOutput: () => true, steps: [
    step("terra", async () => { throw disconnect(); }), step("luna", async () => { ran2 = true; return { text: "x" }; }) ] }));
  assert.ok(e && /cannot close or enqueue/.test(e.message), "expected the disconnect to be re-thrown");
  assert.equal(s.db.terra, undefined, "breaker row must not be written");
  assert.equal(ran2, false);
});

await t("a client disconnect before any output also stops the chain without a breaker write", async () => {
  const s = stub(); let ran2 = false;
  const e = await rejects(runChain({ supaAdmin: s, label: "t", emittedOutput: () => false, steps: [
    step("terra", async () => { throw disconnect(); }), step("luna", async () => { ran2 = true; return { text: "x" }; }) ] }));
  assert.ok(e); assert.equal(s.db.terra, undefined); assert.equal(ran2, false);
});

await t("three abandoned requests in a row do not open the breaker (the 2026-11-14 production case)", async () => {
  const s = stub();
  for (let i = 0; i < 3; i++) await rejects(runChain({ supaAdmin: s, label: "t", emittedOutput: () => true, steps: [step("terra", async () => { throw disconnect(); })] }));
  assert.equal(await isCircuitOpen(s, "terra"), false);
  assert.equal(s.db.terra, undefined);
});

await t("REGRESSION: an ordinary provider error before output still counts and falls to the next step", async () => {
  const s = stub();
  const r = await runChain({ supaAdmin: s, label: "t", emittedOutput: () => false, steps: [
    step("terra", async () => { throw new Error("OpenAI 500: boom"); }), step("luna", async () => ({ text: "from luna" })) ] });
  assert.equal(r.value.text, "from luna"); assert.equal(s.db.terra.consecutive_failures, 1);
});

await t("REGRESSION: an ordinary provider error after output counts and is re-thrown", async () => {
  const s = stub();
  const e = await rejects(runChain({ supaAdmin: s, label: "t", emittedOutput: () => true, steps: [step("terra", async () => { throw new Error("upstream reset"); })] }));
  assert.ok(e); assert.equal(s.db.terra.consecutive_failures, 1);
});

await t("REGRESSION: three real failures still open the breaker", async () => {
  const s = stub();
  for (let i = 0; i < 3; i++) await rejects(runChain({ supaAdmin: s, label: "t", emittedOutput: () => true, steps: [step("terra", async () => { throw new Error("OpenAI 503"); })] }));
  assert.equal(await isCircuitOpen(s, "terra"), true);
});

await t("REGRESSION: the 25s first-response timeout is a provider failure, not a disconnect", async () => {
  const s = stub();
  const e = await rejects(runChain({ supaAdmin: s, label: "t", emittedOutput: () => false, steps: [
    step("terra", async () => { throw new Error("OpenAI gave no response within 25000ms"); }), step("luna", async () => ({ text: "ok" })) ] }));
  assert.equal(e, null); assert.equal(s.db.terra.consecutive_failures, 1);
});

await t("the predicate: matches the controller errors only", async () => {
  assert.equal(typeof isClientDisconnect, "function");
  assert.equal(isClientDisconnect(new TypeError("The stream controller cannot close or enqueue")), true);
  assert.equal(isClientDisconnect(new TypeError("Invalid state: Controller is already closed")), true);
  assert.equal(isClientDisconnect(Object.assign(new Error("x"), { code: "ERR_INVALID_STATE" })), true);
  for (const m of ["OpenAI 429: rate limited", "OpenAI gave no response within 25000ms", "fetch failed", "The operation was aborted", ""]) assert.equal(isClientDisconnect(new Error(m)), false, m);
  assert.equal(isClientDisconnect(null), false); assert.equal(isClientDisconnect(undefined), false);
});

console.log(failed ? `${failed} FAILED, ${n} ok` : `all ${n} ok`);
process.exit(failed ? 1 : 0);
