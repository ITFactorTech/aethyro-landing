// Tests of send-welcome-email v6's farm-account guard against a fake Supabase client + captured Resend calls.
// Run from this directory (Node 22):
//   node --experimental-strip-types --no-warnings --import ./register.mjs send-welcome-email.farm-guard.test.mjs ../../send-welcome-email/index.ts
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
globalThis.Deno = { env: { get: (k) => ({ RESEND_API_KEY: "rk_test", SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "sr" })[k] } };

const UID = "11111111-1111-4111-8111-111111111111";
let world, log, upserts, sends;

function builder(table) {
  const q = { filters: [], opts: null, mode: "select", row: null, inF: null, gte: [] };
  const rows = () => (world.tables[table] || []).filter((r) =>
    q.filters.every(([c, v]) => r[c] === v) &&
    (!q.inF || q.inF[1].includes(r[q.inF[0]])) &&
    q.gte.every(([c, v]) => r[c] >= v));
  const run = () => {
    log.push({ table, filters: q.filters, mode: q.mode });
    if (world.errors?.[table]) return { data: null, count: null, error: { message: `${table} boom` } };
    if (q.mode === "upsert") { upserts.push({ table, row: q.row }); return { data: null, error: null }; }
    const r = rows();
    return { data: q.opts?.head ? null : r, count: q.opts?.count ? r.length : null, error: null };
  };
  const b = {
    select(_c, opts) { q.opts = opts || null; return b; },
    eq(c, v) { q.filters.push([c, v]); return b; },
    in(c, v) { q.inF = [c, v]; return b; },
    gte(c, v) { q.gte.push([c, v]); return b; },
    order() { return b; }, limit() { return b; },
    upsert(row) { q.mode = "upsert"; q.row = row; return b; },
    maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null }); },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return b;
}
globalThis.__makeClient = () => ({
  from: builder,
  rpc: async (fn, args) => {
    log.push({ rpc: fn, args });
    if (world.errors?.rpc) return { data: null, error: { message: "rpc boom" } };
    return { data: world.balance, error: null };
  },
  auth: { admin: { getUserById: async (id) => world.users?.[id] ? { data: { user: world.users[id] }, error: null } : { data: null, error: { message: "nf" } } } },
});
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://api.resend.com/emails");
  sends.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({ id: "msg_1" }), status: 200 };
};

await import(pathToFileURL(file).href);
const mod = await import(pathToFileURL(file).href);
const handler = globalThis.__handler;
assert.equal(typeof handler, "function");

const day = 86400000;
const base = () => ({
  tables: {
    bonus_blocked_domains: [{ domain: "fldubai.com" }],
    credit_ledger: [{ user_id: UID, reason: "signup_bonus", delta: 100 }],
    email_drip_state: [], conversations: [], messages: [], profiles: [{ id: UID, team_id: null }],
  },
  balance: 100, errors: {}, users: {},
});
async function call(body, patch = {}) {
  world = base();
  for (const [k, v] of Object.entries(patch)) world[k] = k === "tables" ? { ...world.tables, ...v } : v;
  log = []; upserts = []; sends = [];
  const quiet = console.error, ql = console.log; console.error = () => {}; console.log = () => {};
  let res; try { res = await handler(new Request("http://f/", { method: "POST", body: JSON.stringify(body) })); } finally { console.error = quiet; console.log = ql; }
  return { status: res.status, body: await res.json(), sends, upserts, log };
}
let n = 0; async function t(name, fn) { await fn(); n++; process.stdout.write(`ok ${n} - ${name}\n`); }
const ok = (type) => ({ ok: true, type });

await t("welcome, normal user: one mail, drip stamped", async () => {
  const r = await call({ type: "welcome", user_id: UID, email: "real@gmail.com" });
  assert.equal(r.status, 200); assert.equal(r.sends.length, 1);
  assert.equal(r.upserts.length, 1); assert.ok(r.upserts[0].row.welcome_sent_at);
});
await t("welcome via the auth-trigger shape ({record}), blocked domain: nothing sent", async () => {
  const r = await call({ type: "INSERT", record: { id: UID, email: "ay123456@fldubai.com" } });
  assert.equal(r.status, 200); assert.equal(r.sends.length, 0); assert.equal(r.upserts.length, 0);
});
await t("welcome, blocked domain: body is identical to a real send (no blocklist oracle)", async () => {
  const sent = await call({ type: "welcome", user_id: UID, email: "real@gmail.com" });
  const skipped = await call({ type: "welcome", user_id: UID, email: "x@fldubai.com" });
  assert.deepEqual(skipped.body, sent.body); assert.deepEqual(skipped.body, ok("welcome"));
});
await t("welcome, domain match is case-insensitive", async () => {
  const r = await call({ type: "welcome", user_id: UID, email: "Bot@FLDUBAI.COM" });
  assert.equal(r.sends.length, 0);
});
await t("welcome, subdomain of a blocked domain is NOT matched (exact match, like the bonus rule)", async () => {
  const r = await call({ type: "welcome", user_id: UID, email: "a@mail.fldubai.com" });
  assert.equal(r.sends.length, 1);
});
await t("welcome, account without a signup_bonus row: nothing sent", async () => {
  const r = await call({ type: "welcome", user_id: UID, email: "real@gmail.com" }, { tables: { credit_ledger: [] } });
  assert.equal(r.sends.length, 0); assert.deepEqual(r.body, ok("welcome"));
});
await t("welcome, garbage or missing user_id: nothing sent (the relay needs a real bonused account now)", async () => {
  for (const uid of ["not-a-uuid", "", undefined, "' or 1=1 --"]) {
    const r = await call({ type: "welcome", user_id: uid, email: "victim@example.org" });
    assert.equal(r.sends.length, 0, String(uid)); assert.equal(r.status, 200);
  }
});
await t("welcome, domain lookup fails: 503 and nothing sent", async () => {
  const r = await call({ type: "welcome", user_id: UID, email: "real@gmail.com" }, { errors: { bonus_blocked_domains: true } });
  assert.equal(r.status, 503); assert.equal(r.sends.length, 0); assert.equal(r.upserts.length, 0);
});
await t("welcome, ledger lookup fails: 503 and nothing sent", async () => {
  const r = await call({ type: "welcome", user_id: UID, email: "real@gmail.com" }, { errors: { credit_ledger: true } });
  assert.equal(r.status, 503); assert.equal(r.sends.length, 0);
});
await t("engagement, normal user with credits: sent and stamped", async () => {
  const r = await call({ type: "engagement", user_id: UID, email: "real@gmail.com" }, { balance: 100 });
  assert.equal(r.sends.length, 1); assert.ok(r.upserts.some((u) => u.row.engagement_sent_at));
});
await t("engagement, blocked domain: NOT sent but STAMPED, so the daily cron never re-selects it", async () => {
  const r = await call({ type: "engagement", user_id: UID, email: "x@fldubai.com" });
  assert.equal(r.sends.length, 0); assert.deepEqual(r.body, ok("engagement"));
  const st = r.upserts.filter((u) => u.table === "email_drip_state");
  assert.equal(st.length, 1); assert.equal(st[0].row.user_id, UID); assert.ok(st[0].row.engagement_sent_at);
});
await t("engagement, balance 0 or negative: not sent, stamped", async () => {
  for (const bal of [0, -34]) {
    const r = await call({ type: "engagement", user_id: UID, email: "real@gmail.com" }, { balance: bal });
    assert.equal(r.sends.length, 0, String(bal)); assert.ok(r.upserts.some((u) => u.row.engagement_sent_at));
  }
});
await t("engagement, balance RPC fails: 503, nothing sent, NOT stamped (cron retries tomorrow)", async () => {
  const r = await call({ type: "engagement", user_id: UID, email: "real@gmail.com" }, { errors: { rpc: true } });
  assert.equal(r.status, 503); assert.equal(r.sends.length, 0); assert.equal(r.upserts.length, 0);
});
await t("engagement, non-numeric balance: 503, nothing sent", async () => {
  const r = await call({ type: "engagement", user_id: UID, email: "real@gmail.com" }, { balance: null });
  assert.equal(r.status, 503); assert.equal(r.sends.length, 0);
});
await t("reengagement, silent user with credits: sent and stamped", async () => {
  const r = await call({ type: "reengagement", user_id: UID, email: "real@gmail.com" }, { balance: 100 });
  assert.equal(r.sends.length, 1); assert.ok(r.upserts.some((u) => u.row.reengagement_sent_at));
});
await t("reengagement, blocked domain or zero balance: not sent, stamped", async () => {
  const a = await call({ type: "reengagement", user_id: UID, email: "x@fldubai.com" });
  assert.equal(a.sends.length, 0); assert.ok(a.upserts.some((u) => u.row.reengagement_sent_at));
  const b = await call({ type: "reengagement", user_id: UID, email: "real@gmail.com" }, { balance: 0 });
  assert.equal(b.sends.length, 0); assert.ok(b.upserts.some((u) => u.row.reengagement_sent_at));
});

// winback: eligible shape = 10 days old, one conversation, messages only on signup day
const created = new Date(Date.now() - 10 * day).toISOString();
const wbWorld = (email = "real@gmail.com") => ({
  users: { [UID]: { id: UID, email, created_at: created } },
  tables: { conversations: [{ id: "c1", user_id: UID, title: "Sourdough", updated_at: created }], messages: [{ conversation_id: "c1", role: "user", created_at: created }] },
});
await t("winback, eligible normal user: one mail, stamped, sent:true", async () => {
  const r = await call({ type: "winback", user_id: UID }, wbWorld());
  assert.equal(r.status, 200); assert.equal(r.sends.length, 1); assert.equal(r.body.sent, true);
  assert.ok(r.upserts.some((u) => u.row.winback_sent_at));
});
await t("winback, blocked-domain account: not sent, stamped, sent:false", async () => {
  const r = await call({ type: "winback", user_id: UID }, wbWorld("bot@fldubai.com"));
  assert.equal(r.sends.length, 0); assert.equal(r.body.sent, false);
  assert.ok(r.upserts.some((u) => u.row.winback_sent_at));
});
await t("winback, account with no signup bonus: not sent, stamped", async () => {
  const w = wbWorld(); w.tables.credit_ledger = [];
  const r = await call({ type: "winback", user_id: UID }, w);
  assert.equal(r.sends.length, 0); assert.ok(r.upserts.some((u) => u.row.winback_sent_at));
});
await t("winback, guard lookup fails: 503, nothing sent, not stamped", async () => {
  const w = wbWorld(); w.errors = { credit_ledger: true };
  const r = await call({ type: "winback", user_id: UID }, w);
  assert.equal(r.status, 503); assert.equal(r.sends.length, 0); assert.equal(r.upserts.length, 0);
});
await t("winback spoofing is still ignored: the body email is never the recipient", async () => {
  const r = await call({ type: "winback", user_id: UID, email: "attacker@evil.test" }, wbWorld("real@gmail.com"));
  assert.equal(r.sends.length, 1); assert.equal(r.sends[0].to, "real@gmail.com");
});
console.log(`all ${n} ok`);
