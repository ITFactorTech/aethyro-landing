// submit-testimonial — public endpoint (verify_jwt: false; auth is the
// single-use token from the request email, not a Supabase session, since
// the person clicking the link may not be signed in on that device). Two
// actions: GET ?token= checks whether a link is still valid/unused (for
// app/feedback.html to show on load, before any submit attempt), POST
// records the actual response via submit_testimonial_response, which is
// itself idempotent (a second submit on a used token is a no-op, not an
// overwrite) -- this function adds the input-shape/length validation on
// top of that DB-level guarantee.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_CONTENT_LEN = 1000;
const MAX_NAME_LEN = 80;

const ALLOWED_ORIGINS = ["https://aethyro.com", "https://www.aethyro.com"];
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-aethyro-landing\.[a-z0-9-]+\.workers\.dev$/;
function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.method === "GET") {
    const token = new URL(req.url).searchParams.get("token");
    if (!token) {
      return new Response(JSON.stringify({ error: "token required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const { data, error } = await supaAdmin.rpc("check_testimonial_token", { p_token: token });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      return new Response(JSON.stringify({ valid: false }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ valid: row.valid, already_submitted: row.already_submitted }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let body: { token?: string; content?: string; display_name?: string; consent?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const token = (body.token || "").trim();
  const content = (body.content || "").trim();
  const displayName = (body.display_name || "").trim().slice(0, MAX_NAME_LEN);
  const consent = body.consent === true;

  if (!token || !content) {
    return new Response(JSON.stringify({ error: "token and content required" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (content.length > MAX_CONTENT_LEN) {
    return new Response(JSON.stringify({ error: `content must be ${MAX_CONTENT_LEN} characters or fewer` }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { data, error } = await supaAdmin.rpc("submit_testimonial_response", {
    p_token: token,
    p_content: content,
    p_display_name: displayName,
    p_consent: consent,
  });

  if (error) {
    console.error("submit-testimonial: RPC failed", error.message);
    return new Response(JSON.stringify({ error: "could not save response" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  if (data !== true) {
    return new Response(JSON.stringify({ error: "invalid or already-used link" }), {
      status: 404, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
