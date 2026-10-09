// connector-proxy v1 — Live integration connector
// Stores PATs/tokens and proxies API calls through them.
// Supports: github (PAT), notion (integration token)
// Actions: connect, disconnect, query, list_integrations
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

// CORS locked to aethyro.com (+ preview subdomains); was a bare "*". See
// chat/index.ts v48's comment for the rationale.
const ALLOWED_ORIGINS = ["https://aethyro.com", "https://www.aethyro.com"];
const PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+-aethyro-landing\.[a-z0-9-]+\.workers\.dev$/;
function corsHeadersFor(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function githubRequest(token: string, path: string, method = "GET", body?: any): Promise<any> {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`GitHub ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Notion helpers ────────────────────────────────────────────────────────────

async function notionRequest(token: string, path: string, method = "GET", body?: any): Promise<any> {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Notion ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Notion block text extractor ───────────────────────────────────────────────

function extractNotionText(blocks: any[]): string {
  return blocks.map(b => {
    const type = b.type;
    const rt = b[type]?.rich_text;
    if (!rt) return "";
    return rt.map((t: any) => t.plain_text || "").join("");
  }).filter(Boolean).join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/, "");
  if (!jwt)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });

  const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await supaUser.auth.getUser();
  if (userErr || !user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const supaAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { action, provider } = body;

  const ok = (data: any) =>
    new Response(JSON.stringify(data), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  // ── list_integrations: what the user has connected ─────────────────────────
  if (action === "list_integrations") {
    const { data } = await supaAdmin
      .from("user_integrations")
      .select("provider, scope, metadata, created_at")
      .eq("user_id", user.id);
    return ok({ integrations: data || [] });
  }

  // ── connect: store a token ─────────────────────────────────────────────────
  if (action === "connect") {
    if (!provider || !["github", "notion"].includes(provider))
      return err("provider must be 'github' or 'notion'");
    const token = (body.token || "").trim();
    if (!token) return err("token required");

    // Validate token by making a test call
    let metadata: any = {};
    try {
      if (provider === "github") {
        const me = await githubRequest(token, "/user");
        metadata = { login: me.login, name: me.name, avatar_url: me.avatar_url };
      } else if (provider === "notion") {
        const me = await notionRequest(token, "/users/me");
        metadata = { name: me.name, type: me.type };
      }
    } catch (e) {
      return err(`Token validation failed: ${(e as Error).message}`);
    }

    // Token is encrypted server-side inside store_integration_token (pgp_sym_encrypt)
    // -- it never touches the access_token column directly from this function's own
    // code. See 20261009000000_encrypt_integration_tokens.sql.
    const { error: storeErr } = await supaAdmin.rpc("store_integration_token", {
      p_user_id: user.id,
      p_provider: provider,
      p_token: token,
      p_metadata: metadata,
    });

    if (storeErr) return err(storeErr.message, 500);
    return ok({ connected: true, provider, metadata });
  }

  // ── disconnect: remove a token ────────────────────────────────────────────
  if (action === "disconnect") {
    if (!provider) return err("provider required");
    await supaAdmin
      .from("user_integrations")
      .delete()
      .eq("user_id", user.id)
      .eq("provider", provider);
    return ok({ disconnected: true, provider });
  }

  // ── query: proxy an API call ──────────────────────────────────────────────
  if (action === "query") {
    if (!provider) return err("provider required");

    // Decrypted server-side inside get_integration_token (pgp_sym_decrypt) --
    // the plaintext token only ever exists transiently in this function's
    // memory, never read from the column directly.
    const { data: token, error: tokenErr } = await supaAdmin.rpc("get_integration_token", {
      p_user_id: user.id,
      p_provider: provider,
    });

    if (tokenErr || !token)
      return err(`No ${provider} integration found. Connect it first.`, 404);

    const { operation } = body;

    try {
      // ── GitHub operations ──────────────────────────────────────────────────
      if (provider === "github") {
        if (operation === "list_repos") {
          const repos = await githubRequest(token, "/user/repos?sort=pushed&per_page=30");
          return ok({ repos: repos.map((r: any) => ({ name: r.full_name, description: r.description, language: r.language, stars: r.stargazers_count, updated: r.pushed_at })) });
        }
        if (operation === "list_issues") {
          const repo = body.repo;
          if (!repo) return err("repo required");
          const issues = await githubRequest(token, `/repos/${repo}/issues?state=open&per_page=20`);
          return ok({ issues: issues.map((i: any) => ({ number: i.number, title: i.title, state: i.state, created: i.created_at, labels: i.labels?.map((l: any) => l.name) })) });
        }
        if (operation === "search_code") {
          const query = body.query;
          if (!query) return err("query required");
          const result = await githubRequest(token, `/search/code?q=${encodeURIComponent(query)}&per_page=10`);
          return ok({ items: result.items?.map((i: any) => ({ path: i.path, repo: i.repository?.full_name, url: i.html_url })) });
        }
        if (operation === "read_file") {
          const { repo, path } = body;
          if (!repo || !path) return err("repo and path required");
          const file = await githubRequest(token, `/repos/${repo}/contents/${path}`);
          const content = file.encoding === "base64"
            ? atob(file.content.replace(/\n/g, ""))
            : file.content;
          return ok({ path: file.path, content: content.slice(0, 20000), size: file.size });
        }
        if (operation === "list_prs") {
          const repo = body.repo;
          if (!repo) return err("repo required");
          const prs = await githubRequest(token, `/repos/${repo}/pulls?state=open&per_page=20`);
          return ok({ prs: prs.map((p: any) => ({ number: p.number, title: p.title, user: p.user?.login, created: p.created_at, url: p.html_url })) });
        }
        return err(`Unknown GitHub operation: ${operation}`);
      }

      // ── Notion operations ──────────────────────────────────────────────────
      if (provider === "notion") {
        if (operation === "search") {
          const query = body.query || "";
          const result = await notionRequest(token, "/search", "POST", {
            query,
            page_size: 10,
            filter: { value: "page", property: "object" },
          });
          return ok({
            pages: result.results?.map((p: any) => ({
              id: p.id,
              title: p.properties?.title?.title?.[0]?.plain_text || p.properties?.Name?.title?.[0]?.plain_text || "Untitled",
              url: p.url,
              last_edited: p.last_edited_time,
            }))
          });
        }
        if (operation === "read_page") {
          const pageId = body.page_id;
          if (!pageId) return err("page_id required");
          const [page, blocks] = await Promise.all([
            notionRequest(token, `/pages/${pageId}`),
            notionRequest(token, `/blocks/${pageId}/children?page_size=100`),
          ]);
          const title =
            page.properties?.title?.title?.[0]?.plain_text ||
            page.properties?.Name?.title?.[0]?.plain_text ||
            "Untitled";
          const content = extractNotionText(blocks.results || []);
          return ok({ id: pageId, title, content: content.slice(0, 10000) });
        }
        if (operation === "list_databases") {
          const result = await notionRequest(token, "/search", "POST", {
            filter: { value: "database", property: "object" },
            page_size: 20,
          });
          return ok({
            databases: result.results?.map((d: any) => ({
              id: d.id,
              title: d.title?.[0]?.plain_text || "Untitled",
              url: d.url,
            }))
          });
        }
        return err(`Unknown Notion operation: ${operation}`);
      }

      return err(`Unknown provider: ${provider}`);
    } catch (e) {
      return err(`Query failed: ${(e as Error).message}`, 500);
    }
  }

  return err("action must be 'connect', 'disconnect', 'query', or 'list_integrations'");
});
