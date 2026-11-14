// Tests of the signup-gate auth hook against a fake Cloudflare siteverify.
//   node --experimental-strip-types --no-warnings --import ./register.mjs signup-gate.test.mjs ../../signup-gate/index.ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

let env = {};
globalThis.Deno = { env: { get: (k) => env[k] } };
let cf;     // per-test fake Cloudflare behaviour: { status, json, throws, hang }
let calls;  // captured siteverify calls
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  calls.push({ body: new URLSearchParams(init.body.toString()), signal: init.signal });
  if (cf.throws) throw new Error(cf.throws);
  if (cf.hang) await new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  return { status: cf.status ?? 200, json: async () => { if (cf.badJson) throw new Error("not json"); return cf.json ?? { success: true }; } };
};

const mod = await import(pathToFileURL(process.argv[2]).href);
const handler = globalThis.__handler;
assert.equal(typeof handler, "function");

const payload = (over = {}) => ({
  metadata: { uuid: "x", time: "t", name: "before-user-created", ip_address: "203.0.113.9" },
  user: { id: "u", email: "a@b.test", app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { cf_turnstile_token: "tok-ok" }, ...over },
});
async function call(body, { headers = {}, rawBody, e = { TURNSTILE_SECRET_KEY: "ts_secret" }, cfBehaviour = {} } = {}) {
  env = e; cf = cfBehaviour; calls = [];
  const quiet = [console.log, console.error, console.warn]; console.log = console.error = console.warn = () => {};
  let res; try { res = await handler(new Request("http://f/", { method: "POST", headers, body: rawBody ?? JSON.stringify(body) })); } finally { [console.log, console.error, console.warn] = quiet; }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, calls };
}
const refused = (r) => r.status === 400 && r.body?.error?.http_code === 400 && /human check/i.test(r.body.error.message);
let n = 0; async function t(name, fn) { await fn(); n++; process.stdout.write(`ok ${n} - ${name}\n`); }

await t("email signup with a token Cloudflare accepts: allowed ({})", async () => {
  const r = await call(payload());
  assert.equal(r.status, 200); assert.deepEqual(r.body, {});
});
await t("sends secret, response token and the client IP to siteverify", async () => {
  const r = await call(payload());
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body.get("secret"), "ts_secret"); assert.equal(r.calls[0].body.get("response"), "tok-ok"); assert.equal(r.calls[0].body.get("remoteip"), "203.0.113.9");
});
await t("email signup with NO token: refused, Cloudflare never called", async () => {
  const r = await call(payload({ user_metadata: {} }));
  assert.ok(refused(r)); assert.equal(r.calls.length, 0);
});
await t("empty, non-string or oversized tokens: refused without calling Cloudflare", async () => {
  for (const tok of ["", 123, null, { a: 1 }, "x".repeat(2049)]) {
    const r = await call(payload({ user_metadata: { cf_turnstile_token: tok } }));
    assert.ok(refused(r), String(tok).slice(0, 20)); assert.equal(r.calls.length, 0);
  }
});
await t("a token Cloudflare REJECTS (bad or reused): refused", async () => {
  const r = await call(payload(), { cfBehaviour: { json: { success: false, "error-codes": ["timeout-or-duplicate"] } } });
  assert.ok(refused(r));
});
await t("OAuth signup (google / github): allowed with no token, Cloudflare never called", async () => {
  for (const p of ["google", "github"]) {
    const r = await call(payload({ app_metadata: { provider: p, providers: [p] }, user_metadata: {} }));
    assert.equal(r.status, 200); assert.equal(r.calls.length, 0);
  }
});
await t("Cloudflare unreachable / 5xx / unparseable: FAIL OPEN (allowed)", async () => {
  for (const b of [{ throws: "ECONNRESET" }, { status: 503 }, { status: 500 }, { badJson: true }]) {
    const r = await call(payload(), { cfBehaviour: b });
    assert.equal(r.status, 200, JSON.stringify(b)); assert.deepEqual(r.body, {});
  }
});
await t("Cloudflare says the SECRET is wrong/missing or an internal error: FAIL OPEN (a typo must not lock out signups)", async () => {
  for (const code of ["invalid-input-secret", "missing-input-secret", "internal-error"]) {
    const r = await call(payload(), { cfBehaviour: { json: { success: false, "error-codes": [code] } } });
    assert.equal(r.status, 200, code); assert.deepEqual(r.body, {});
  }
});
await t("other Cloudflare rejections (invalid-input-response, timeout-or-duplicate): refused", async () => {
  for (const code of ["invalid-input-response", "timeout-or-duplicate", "missing-input-response"]) {
    const r = await call(payload(), { cfBehaviour: { json: { success: false, "error-codes": [code] } } });
    assert.ok(refused(r), code);
  }
});
await t("Cloudflare hangs: aborted after ~4s and FAIL OPEN", async () => {
  const t0 = Date.now(); const r = await call(payload(), { cfBehaviour: { hang: true } });
  assert.equal(r.status, 200); const dt = Date.now() - t0; assert.ok(dt >= 3800 && dt < 6000, `took ${dt}ms`);
});
await t("TURNSTILE_SECRET_KEY not set: inert, allows everything, no outbound call", async () => {
  const r = await call(payload({ user_metadata: {} }), { e: {} });
  assert.equal(r.status, 200); assert.equal(r.calls.length, 0);
});
await t("malformed JSON body: 400 (never a 500)", async () => {
  const r = await call(null, { rawBody: "{nope" }); assert.equal(r.status, 400);
});
await t("GET is refused", async () => {
  const res = await handler(new Request("http://f/", { method: "GET" })); assert.equal(res.status, 405);
});

// Standard Webhooks signatures (only enforced when SIGNUP_GATE_HOOK_SECRET is set)
const rawSecret = Buffer.from("super-secret-bytes-for-test-123456").toString("base64");
const HOOK = "v1,whsec_" + rawSecret;
const sign = (id, ts, body, secret = rawSecret) => "v1," + createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
const signed = (body, over = {}) => {
  const id = "msg_1", ts = String(Math.floor(Date.now() / 1000));
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sign(id, ts, body), ...over };
};
const E = { TURNSTILE_SECRET_KEY: "ts_secret", SIGNUP_GATE_HOOK_SECRET: HOOK };
await t("signature configured + valid: allowed through to the check", async () => {
  const body = JSON.stringify(payload()); const r = await call(null, { rawBody: body, headers: signed(body), e: E });
  assert.equal(r.status, 200); assert.equal(r.calls.length, 1);
});
await t("signature configured + missing headers: 401 and Cloudflare never called", async () => {
  const body = JSON.stringify(payload()); const r = await call(null, { rawBody: body, e: E });
  assert.equal(r.status, 401); assert.equal(r.calls.length, 0);
});
await t("signature configured + wrong signature or tampered body: 401", async () => {
  const body = JSON.stringify(payload());
  const a = await call(null, { rawBody: body, headers: signed(body, { "webhook-signature": sign("msg_1", "1", body) }), e: E });
  assert.equal(a.status, 401);
  const h = signed(body); const b = await call(null, { rawBody: body.replace("a@b.test", "evil@b.test"), headers: h, e: E });
  assert.equal(b.status, 401);
});
await t("signature configured + stale timestamp (replay): 401", async () => {
  const body = JSON.stringify(payload()); const ts = String(Math.floor(Date.now() / 1000) - 3600);
  const r = await call(null, { rawBody: body, headers: { "webhook-id": "m", "webhook-timestamp": ts, "webhook-signature": sign("m", ts, body) }, e: E });
  assert.equal(r.status, 401);
});
await t("signature header with several entries (key rotation): accepted when one matches", async () => {
  const body = JSON.stringify(payload()); const h = signed(body); h["webhook-signature"] = "v1,AAAA " + h["webhook-signature"];
  const r = await call(null, { rawBody: body, headers: h, e: E }); assert.equal(r.status, 200);
});
console.log(`all ${n} ok`);
