// signup-gate v1 -- Supabase Auth "Before User Created" HTTP hook (2026-11-14).
//
// Why: the scripted signup farms (fldubai.com, maxxspace.com, the Gmail
// dot-variant cluster ...) call the Auth API directly, so no check in the signup
// PAGE ever sees them. This hook runs inside Auth, before the user row exists, and
// refuses an EMAIL signup (password or magic link) that does not carry a valid
// Cloudflare Turnstile token. A real visitor solves the widget on /app/signup.html
// (usually invisibly); a script calling /auth/v1/signup has no token.
//
// Deliberately narrow:
//  - OAuth signups (Google / GitHub) are allowed untouched: they need a real
//    third-party account, and signup.html does not run for them.
//  - Sign-IN is not affected at all (this hook only fires on user creation), so
//    logins, the password grant used by our own test tooling, and password reset
//    keep working with no widget. (Supabase's built-in CAPTCHA toggle would gate
//    all of those.)
//  - INERT until configured: with no TURNSTILE_SECRET_KEY secret the function
//    allows everything. Setting the secret AND enabling the hook in the Supabase
//    dashboard is what turns enforcement on.
//  - FAILS OPEN when Cloudflare itself is unreachable / times out / answers 5xx, and
//    when Cloudflare says the SECRET is wrong or missing (our setup mistake): a
//    Turnstile outage or a typo must not stop real signups, and the log line says so.
//    A token Cloudflare explicitly rejects, or a missing token, is a refusal.
//
// The token travels in user_metadata (options.data.cf_turnstile_token) because the
// hook payload does not carry Supabase's own captchaToken. The paired migration
// strips it again before the row is stored.
//
// Hook responses (docs): allow = 200 {}; refuse = 4xx {error:{http_code,message}}.
//
// Env: TURNSTILE_SECRET_KEY (Cloudflare Turnstile secret). Optional:
// SIGNUP_GATE_HOOK_SECRET ("v1,whsec_<base64>" from the dashboard's hook screen);
// when set, requests must carry a valid Standard Webhooks signature.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 4000;
const MAX_TOKEN_LEN = 2048;           // Cloudflare's documented maximum
const SIGNATURE_TOLERANCE_S = 300;

const JSON_HEADERS = { "Content-Type": "application/json" };
const allow = () => new Response("{}", { status: 200, headers: JSON_HEADERS });
const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: JSON_HEADERS });

const HUMAN_MSG = "Please complete the human check on the sign-up page and try again. If it doesn't load, turn off blockers for this page or sign up with Google or GitHub.";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Standard Webhooks (what Supabase Auth hooks use): HMAC-SHA256 over
// "<webhook-id>.<webhook-timestamp>.<body>" with the base64 secret; the header
// carries one or more space-separated "v1,<base64 signature>" entries.
export async function verifySignature(secret: string, headers: Headers, body: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const id = headers.get("webhook-id");
    const ts = headers.get("webhook-timestamp");
    const sigHeader = headers.get("webhook-signature");
    if (!id || !ts || !sigHeader) return false;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(nowMs / 1000 - tsNum) > SIGNATURE_TOLERANCE_S) return false;
    const raw = secret.replace(/^v1,/, "").replace(/^whsec_/, "");
    const key = await crypto.subtle.importKey("raw", b64ToBytes(raw) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${id}.${ts}.${body}`);
    for (const part of sigHeader.split(" ")) {
      const [ver, sig] = part.split(",");
      if (ver !== "v1" || !sig) continue;
      if (await crypto.subtle.verify("HMAC", key, b64ToBytes(sig) as BufferSource, signed)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

type Verdict = { ok: true } | { ok: false; reason: string } | { ok: "unavailable"; reason: string };

async function verifyWithCloudflare(secret: string, token: string, ip: string | undefined): Promise<Verdict> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form, signal: ctrl.signal });
    if (res.status >= 500) return { ok: "unavailable", reason: `cloudflare ${res.status}` };
    const j = await res.json();
    if (j && j.success === true) return { ok: true };
    const codes: string[] = Array.isArray(j?.["error-codes"]) ? j["error-codes"] : [];
    // A wrong or missing SECRET, or a Cloudflare-side error, is OUR misconfiguration or
    // theirs, not evidence about this visitor. Refusing on it would lock out every
    // email signup the moment someone mistypes the secret, so treat it like an outage:
    // allow, and log loudly so it gets fixed.
    if (codes.some((c) => c === "invalid-input-secret" || c === "missing-input-secret" || c === "internal-error")) {
      return { ok: "unavailable", reason: "cloudflare config/internal: " + codes.join(",") };
    }
    return { ok: false, reason: codes.length ? codes.join(",") : "rejected" };
  } catch (e) {
    return { ok: "unavailable", reason: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method !== "POST") return refuse(405, "method not allowed");
  const raw = await req.text();

  const hookSecret = Deno.env.get("SIGNUP_GATE_HOOK_SECRET");
  if (hookSecret && !(await verifySignature(hookSecret, req.headers, raw))) {
    console.error("signup-gate: bad or missing webhook signature");
    return refuse(401, "unauthorized");
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return refuse(400, "invalid request"); }
  const user = payload?.user ?? {};
  const meta = payload?.metadata ?? {};

  const provider = String(user?.app_metadata?.provider ?? "");
  if (provider !== "email") return allow();             // OAuth: not our concern

  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) {                                        // not configured yet: inert
    console.warn("signup-gate: TURNSTILE_SECRET_KEY not set, allowing");
    return allow();
  }

  const token = user?.user_metadata?.cf_turnstile_token;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN) {
    console.log("signup-gate: refused (no usable token)");
    return refuse(400, HUMAN_MSG);
  }

  const v = await verifyWithCloudflare(secret, token, typeof meta.ip_address === "string" ? meta.ip_address : undefined);
  if (v.ok === true) return allow();
  if (v.ok === "unavailable") {
    console.error("signup-gate: Cloudflare unavailable, allowing:", v.reason);
    return allow();
  }
  console.log("signup-gate: refused (turnstile said", v.reason + ")");
  return refuse(400, HUMAN_MSG);
});
