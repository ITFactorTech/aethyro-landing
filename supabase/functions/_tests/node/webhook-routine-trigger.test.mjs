// Tests of webhook-routine-trigger's cooldown claim against a fake Supabase client.
//   node --experimental-strip-types --no-warnings --import ./register.mjs webhook-routine-trigger.test.mjs ../../webhook-routine-trigger/index.ts
// The fake models the one database property the fix relies on: a conditional UPDATE
// is evaluated against the row AS IT IS when the update runs (Postgres re-checks the
// WHERE after waiting on the row lock), not as it was when the caller read it.
// supabase/tests/webhook-cooldown-claim.sh checks that property on a real Postgres.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const SRK = "service-role-key-for-tests";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://sb.test", SUPABASE_SERVICE_ROLE_KEY: SRK })[k] } };

let rows;        // routine_webhooks, keyed by id
let invokes;     // captured functions.invoke calls
let failClaim;   // make the UPDATE return an error
let writes;      // every UPDATE the function attempted
const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));

// `col.is.null,col.lte.<iso>` / `col.lt.<iso>` -- anything else is a test failure, so a
// typo in the filter the function builds cannot pass silently.
function orMatches(filter, row) {
  return filter.split(",").some((term) => {
    const m = /^([a-z_]+)\.(is|lt|lte)\.(.+)$/.exec(term);
    assert.ok(m, `unparseable or() term: ${term}`);
    const [, col, op, val] = m;
    assert.equal(col, "last_triggered_at");
    if (op === "is") { assert.equal(val, "null"); return row[col] == null; }
    assert.ok(!Number.isNaN(Date.parse(val)), `not a timestamp: ${val}`);
    if (row[col] == null) return false;
    const a = Date.parse(row[col]), b = Date.parse(val);
    return op === "lt" ? a < b : a <= b;
  });
}

function builder(table) {
  assert.equal(table, "routine_webhooks");
  const q = { op: null, eqs: {}, or: null, payload: null, returning: false, single: false };
  const b = {
    select(cols) { if (q.op === "update") q.returning = true; else { q.op = "select"; q.cols = cols; } return b; },
    update(payload) { q.op = "update"; q.payload = payload; return b; },
    eq(col, val) { q.eqs[col] = val; return b; },
    or(f) { q.or = f; return b; },
    single() { q.single = true; return b; },
    then(resolve, reject) { return run().then(resolve, reject); },
  };
  async function run() {
    await tick();   // a network round trip: lets every concurrent caller get its read in first
    const match = Object.values(rows).filter((r) => Object.entries(q.eqs).every(([c, v]) => r[c] === v));
    if (q.op === "select") {
      assert.ok(q.single);
      return match.length === 1 ? { data: { ...match[0] }, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
    }
    assert.equal(q.op, "update");
    writes.push({ or: q.or, payload: q.payload });
    if (failClaim) return { data: null, error: { message: "db unavailable" } };
    const hit = match.filter((r) => (q.or ? orMatches(q.or, r) : true));
    for (const r of hit) Object.assign(r, q.payload);          // evaluated and applied atomically
    return { data: q.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
  }
  return b;
}
globalThis.__makeClient = () => ({
  from: builder,
  functions: { invoke: async (name, opts) => { invokes.push({ name, opts }); await tick(); return { data: { ok: true }, error: null }; } },
});

let logged = [];            // the function logs claim / invoke failures; capture instead of printing
console.error = (...a) => { logged.push(a.join(" ")); };
await import(pathToFileURL(process.argv[2]).href);
const handler = globalThis.__handler;
assert.equal(typeof handler, "function");

const HOOK = "11111111-1111-1111-1111-111111111111", ROUTINE = "22222222-2222-2222-2222-222222222222";
function seed(last_triggered_at = null, trigger_count = 0) {
  rows = { [HOOK]: { id: HOOK, token: "tok-real", routine_id: ROUTINE, last_triggered_at, trigger_count } };
  invokes = []; writes = []; failClaim = false;
}
async function hit(token = "tok-real", method = "POST") {
  const res = await handler(new Request(`http://f/webhook-routine-trigger${token == null ? "" : `?token=${token}`}`, { method }));
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const count = (rs, s) => rs.filter((r) => r.status === s).length;
let n = 0; async function t(name, fn) { await fn(); n++; process.stdout.write(`ok ${n} - ${name}\n`); }

await t("no token: 400, nothing read or run", async () => {
  seed(); const r = await hit(null);
  assert.equal(r.status, 400); assert.equal(invokes.length, 0); assert.equal(writes.length, 0);
});
await t("unknown token: 404, nothing written or run", async () => {
  seed(); const r = await hit("tok-wrong");
  assert.equal(r.status, 404); assert.equal(invokes.length, 0); assert.equal(writes.length, 0);
});
await t("first ever trigger: runs the routine once as the service role", async () => {
  seed(); const r = await hit();
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
  assert.equal(invokes.length, 1); assert.equal(invokes[0].name, "run-routines");
  assert.deepEqual(invokes[0].opts.body, { routine_id: ROUTINE });
  assert.equal(invokes[0].opts.headers.Authorization, `Bearer ${SRK}`);
  assert.equal(rows[HOOK].trigger_count, 1); assert.ok(Date.now() - Date.parse(rows[HOOK].last_triggered_at) < 2000);
});
await t("inside the cooldown: 429, no write, no run", async () => {
  seed(ago(5_000), 4); const r = await hit();
  assert.equal(r.status, 429); assert.deepEqual(r.body, { skipped: "cooldown" });
  assert.equal(invokes.length, 0); assert.equal(writes.length, 0); assert.equal(rows[HOOK].trigger_count, 4);
});
await t("cooldown expired: runs again and counts it", async () => {
  seed(ago(31_000), 4); const r = await hit();
  assert.equal(r.status, 200); assert.equal(invokes.length, 1); assert.equal(rows[HOOK].trigger_count, 5);
});
await t("two hits one after the other: the second is cooldown-blocked", async () => {
  seed(); const a = await hit(), b = await hit();
  assert.equal(a.status, 200); assert.equal(b.status, 429); assert.equal(invokes.length, 1); assert.equal(rows[HOOK].trigger_count, 1);
});
await t("10 SIMULTANEOUS hits on a never-triggered hook: exactly one runs, nine get 429", async () => {
  seed(); const rs = await Promise.all(Array.from({ length: 10 }, () => hit()));
  assert.equal(count(rs, 200), 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(count(rs, 429), 9); assert.equal(invokes.length, 1); assert.equal(rows[HOOK].trigger_count, 1);
});
await t("10 SIMULTANEOUS hits after the cooldown expired: exactly one runs", async () => {
  seed(ago(60_000), 7); const rs = await Promise.all(Array.from({ length: 10 }, () => hit()));
  assert.equal(count(rs, 200), 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(count(rs, 429), 9); assert.equal(invokes.length, 1); assert.equal(rows[HOOK].trigger_count, 8);
});
await t("the claim is ONE conditional update that re-checks the cooldown in the database", async () => {
  seed(ago(60_000)); await hit();
  assert.equal(writes.length, 1);
  assert.match(writes[0].or ?? "", /^last_triggered_at\.is\.null,last_triggered_at\.lte?\.\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  const cutoff = Date.parse(/\.lte?\.(\d.+)$/.exec(writes[0].or)[1]);
  assert.ok(Math.abs(Date.now() - 30_000 - cutoff) < 2000, "cutoff is now minus 30 s");
});
await t("claim fails (database error): 503, the routine does NOT run", async () => {
  seed(); failClaim = true; const r = await hit();
  assert.equal(r.status, 503); assert.equal(invokes.length, 0);
  assert.ok(!JSON.stringify(r.body).includes("db unavailable"), "internal error text is not returned to the caller");
});
await t("claim fails for every one of 5 simultaneous hits: none runs", async () => {
  seed(); failClaim = true; const rs = await Promise.all(Array.from({ length: 5 }, () => hit()));
  assert.equal(count(rs, 503), 5); assert.equal(invokes.length, 0);
});
await t("run-routines throwing still answers 200 and keeps the claim (no retry storm, no leak)", async () => {
  seed(); const real = globalThis.__makeClient;
  globalThis.__makeClient = () => ({ from: builder, functions: { invoke: async () => { invokes.push({}); throw new Error("secret internal detail"); } } });
  let r; try { r = await hit(); } finally { globalThis.__makeClient = real; }
  assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes("secret")); assert.equal(rows[HOOK].trigger_count, 1);
});
await t("run-routines answering non-2xx (a returned error, not a throw): logged, still 200, nothing leaked", async () => {
  seed(); logged = []; const real = globalThis.__makeClient;
  globalThis.__makeClient = () => ({ from: builder, functions: { invoke: async () => { invokes.push({}); return { data: null, error: { message: "Edge Function returned a non-2xx status code" } }; } } });
  let r; try { r = await hit(); } finally { globalThis.__makeClient = real; }
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true });
  assert.ok(logged.some((l) => /run-routines returned an error/.test(l)), "the failure is logged");
});
await t("OPTIONS preflight: answered without touching the database", async () => {
  seed(); const r = await hit("tok-real", "OPTIONS");
  assert.equal(r.status, 200); assert.equal(writes.length, 0); assert.equal(invokes.length, 0);
});
process.stdout.write(`# ${n} tests passed\n`);
