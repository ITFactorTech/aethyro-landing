// Supabase Auth Hook: fires on signup before the user is created.
// Blocks passwords found in the HaveIBeenPwned breached-password database.
// Uses the k-anonymity Range API — only the first 5 chars of the SHA-1 hash
// are ever sent, so the plaintext password never leaves the user's request.

const HOOK_SECRET = Deno.env.get("HOOK_SECRET");

// Verify the HMAC-SHA256 signature Supabase Auth sends with every hook request.
async function verifySignature(
  secret: string,
  body: string,
  sigHeader: string | null
): Promise<boolean> {
  if (!sigHeader) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  // Supabase sends: "sha256=<hex digest>"
  const hex = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  const sigBytes = Uint8Array.from(
    hex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}

// SHA-1 hash via Web Crypto (no node:crypto needed in Deno).
async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

interface HookPayload {
  type: "BEFORE_USER_CREATED";
  event: {
    user: { email: string; user_metadata?: Record<string, unknown> };
    email_action_type?: string;
  };
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
    console.warn(`HIBP API returned ${res.status}; allowing signup`);
    return false; // fail open — don't block users on HIBP outage
  }

  const text = await res.text();
  for (const line of text.split("\r\n")) {
    const [hashSuffix, countStr] = line.split(":");
    if (hashSuffix === suffix && parseInt(countStr, 10) > 0) {
      return true;
    }
  }
  return false;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();

    // Reject requests that don't carry a valid signature from Supabase Auth.
    if (HOOK_SECRET) {
      const sig = req.headers.get("x-supabase-signature");
      const valid = await verifySignature(HOOK_SECRET, rawBody, sig);
      if (!valid) {
        return new Response(
          JSON.stringify({ error: { http_code: 401, message: "Unauthorized" } }),
          { status: 200, headers: JSON_HEADERS }
        );
      }
    }

    const payload: HookPayload = JSON.parse(rawBody);

    if (!payload.password) {
      return new Response(JSON.stringify({}), { headers: JSON_HEADERS });
    }

    const isBreached = await checkHibp(payload.password);

    if (isBreached) {
      return new Response(
        JSON.stringify({
          error: {
            http_code: 422,
            message:
              "This password has appeared in a data breach. Please choose a different password.",
          },
        }),
        { status: 200, headers: JSON_HEADERS }
      );
    }

    return new Response(JSON.stringify({}), { headers: JSON_HEADERS });
  } catch (err) {
    console.error("check-leaked-password hook error:", err);
    return new Response(JSON.stringify({}), { headers: JSON_HEADERS }); // fail open
  }
});
