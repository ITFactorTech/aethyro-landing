// Supabase Auth Hook: fires on signup before the user is created.
// Blocks passwords found in the HaveIBeenPwned breached-password database.
// Uses the k-anonymity Range API — only the first 5 chars of the SHA-1 hash
// are ever sent, so the plaintext password never leaves the user's request.
//
// NOTE: Supabase free tier does NOT include the plaintext password in the
// before_user_created hook payload. The client-side HIBP check in signup.html
// is the primary defense. This hook provides defense-in-depth for future
// hook types or plan upgrades that do expose the password.

const HOOK_SECRET = Deno.env.get("HOOK_SECRET");

// Verify HMAC-SHA256 — Supabase sends "sha256=<hex>" in x-supabase-signature.
async function verifyHmac(secret: string, body: string, sigHeader: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const hex = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  try {
    const sigBytes = Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
  } catch {
    return false;
  }
}

// Verify a JWT Bearer token signed with the hook secret (HS256).
async function verifyJwt(secret: string, token: string): Promise<boolean> {
  try {
    const [headerB64, payloadB64, sigB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !sigB64) return false;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const sig = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return crypto.subtle.verify("HMAC", key, sig, data);
  } catch {
    return false;
  }
}

async function isAuthorized(req: Request, body: string): Promise<boolean> {
  if (!HOOK_SECRET) return true;

  const hmacSig = req.headers.get("x-supabase-signature");
  if (hmacSig) return verifyHmac(HOOK_SECRET, body, hmacSig);

  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return verifyJwt(HOOK_SECRET, auth.slice(7));

  // No signature header found — fail open to avoid blocking signups due to
  // header format mismatches. The client-side HIBP check is the primary guard.
  console.warn("hook: no signature header found — allowing (client-side check is primary)");
  return true;
}

// SHA-1 via Web Crypto (Deno native, no node:crypto).
async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

interface HookPayload {
  type: "BEFORE_USER_CREATED";
  event: { user: { email: string } };
  password?: string;
}

async function checkHibp(password: string): Promise<boolean> {
  const sha1 = await sha1Hex(password);
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true" },
  });
  if (!res.ok) {
    console.warn(`HIBP ${res.status}; allowing signup`);
    return false;
  }
  for (const line of (await res.text()).split("\r\n")) {
    const [s, c] = line.split(":");
    if (s === suffix && parseInt(c, 10) > 0) return true;
  }
  return false;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();

    if (!(await isAuthorized(req, rawBody))) {
      console.warn("hook: unauthorized request rejected");
      return new Response(
        JSON.stringify({ error: { http_code: 401, message: "Unauthorized" } }),
        { status: 200, headers: JSON_HEADERS }
      );
    }

    const payload: HookPayload = JSON.parse(rawBody);

    if (!payload.password) {
      // Free-tier hook: password not included in payload. Client-side check handles this.
      return new Response(JSON.stringify({}), { headers: JSON_HEADERS });
    }

    if (await checkHibp(payload.password)) {
      return new Response(
        JSON.stringify({
          error: {
            http_code: 422,
            message: "This password has appeared in a data breach. Please choose a different password.",
          },
        }),
        { status: 200, headers: JSON_HEADERS }
      );
    }

    return new Response(JSON.stringify({}), { headers: JSON_HEADERS });
  } catch (err) {
    console.error("check-leaked-password error:", err);
    return new Response(JSON.stringify({}), { headers: JSON_HEADERS }); // fail open
  }
});
