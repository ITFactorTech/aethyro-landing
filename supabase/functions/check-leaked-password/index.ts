import { createHash } from "node:crypto";

// Supabase Auth Hook: fires on signup before the user is created.
// Blocks passwords found in the HaveIBeenPwned breached-password database.
// Uses the k-anonymity Range API — only the first 5 chars of the SHA-1 hash
// are ever sent, so the plaintext password never leaves the user's request.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface HookPayload {
  type: "BEFORE_USER_CREATED";
  event: {
    user: {
      email: string;
      user_metadata?: Record<string, unknown>;
    };
    email_action_type?: string;
  };
  // Supabase passes the raw password only inside Auth Hooks (server-side only).
  // It is NOT present in client-side requests.
  password?: string;
}

async function checkHibp(password: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true" }, // pads response to resist traffic analysis
  });

  if (!res.ok) {
    // If HIBP is unreachable, fail open (allow signup) to avoid blocking users.
    console.warn(`HIBP API returned ${res.status}; allowing signup`);
    return false;
  }

  const text = await res.text();
  for (const line of text.split("\r\n")) {
    const [hashSuffix, countStr] = line.split(":");
    if (hashSuffix === suffix && parseInt(countStr, 10) > 0) {
      return true; // password is breached
    }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const payload: HookPayload = await req.json();

    // Only act on signup events that include a password.
    if (!payload.password) {
      return new Response(JSON.stringify({}), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        {
          status: 200, // Auth hooks always return 200; the error object signals refusal
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Password is clean — allow signup to proceed.
    return new Response(JSON.stringify({}), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("check-leaked-password hook error:", err);
    // Fail open on unexpected errors.
    return new Response(JSON.stringify({}), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
