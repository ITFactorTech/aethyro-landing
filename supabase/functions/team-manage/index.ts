// team-manage — every mutation to profiles.team_id / teams goes through
// here (service role). Nothing lets a client write profiles.team_id
// directly (see the migration's note): this function is the only place
// team membership actually changes, so authorization for each action lives
// in exactly one place.
//
// Actions (all via POST body.action): create, invite, remove, leave, list.
// No "disband"/delete-team action exists — see the migration for why
// (leftover pool balance on team deletion is a real product decision,
// not a technical one, and this pass deliberately doesn't make it).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

serve(async (req) => {
  const CORS = corsHeadersFor(req);
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return json({ error: "not authenticated" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const action = body.action;

  const { data: me, error: meErr } = await supabase
    .from("profiles").select("team_id").eq("id", user.id).single();
  if (meErr) return json({ error: "profile lookup failed" }, 500);

  if (action === "create") {
    if (me.team_id) return json({ error: "already on a team — leave it first" }, 409);
    const name = (body.name || "").trim().slice(0, 60) || "My Team";

    const { data: team, error: teamErr } = await supabase
      .from("teams").insert({ name, owner_id: user.id }).select().single();
    if (teamErr) return json({ error: teamErr.message }, 500);

    const { error: profErr } = await supabase
      .from("profiles").update({ team_id: team.id }).eq("id", user.id);
    if (profErr) return json({ error: profErr.message }, 500);

    return json({ team });
  }

  if (action === "invite") {
    if (!me.team_id) return json({ error: "you're not on a team" }, 400);
    const { data: team } = await supabase.from("teams").select("owner_id").eq("id", me.team_id).single();
    if (!team || team.owner_id !== user.id) return json({ error: "only the team owner can invite" }, 403);

    const email = (body.email || "").trim().toLowerCase();
    if (!email) return json({ error: "email required" }, 400);

    const { data: targetId, error: lookupErr } = await supabase.rpc("lookup_user_id_by_email", { p_email: email });
    if (lookupErr) return json({ error: "lookup failed" }, 500);
    if (!targetId) return json({ error: "no Aethyro account with that email" }, 404);

    const { data: target } = await supabase.from("profiles").select("team_id").eq("id", targetId).single();
    if (target?.team_id) return json({ error: "that person is already on a team" }, 409);

    const { error: updErr } = await supabase.from("profiles").update({ team_id: me.team_id }).eq("id", targetId);
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true });
  }

  if (action === "remove") {
    if (!me.team_id) return json({ error: "you're not on a team" }, 400);
    const { data: team } = await supabase.from("teams").select("owner_id").eq("id", me.team_id).single();
    if (!team || team.owner_id !== user.id) return json({ error: "only the team owner can remove members" }, 403);

    const targetId = body.user_id;
    if (!targetId) return json({ error: "user_id required" }, 400);
    if (targetId === user.id) return json({ error: "use 'leave' to remove yourself" }, 400);

    const { data: target } = await supabase.from("profiles").select("team_id").eq("id", targetId).single();
    if (!target || target.team_id !== me.team_id) return json({ error: "that person isn't on your team" }, 404);

    const { error: updErr } = await supabase.from("profiles").update({ team_id: null }).eq("id", targetId);
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true });
  }

  if (action === "leave") {
    if (!me.team_id) return json({ error: "you're not on a team" }, 400);
    const { error: updErr } = await supabase.from("profiles").update({ team_id: null }).eq("id", user.id);
    if (updErr) return json({ error: updErr.message }, 500);
    return json({ ok: true });
  }

  if (action === "list") {
    if (!me.team_id) return json({ team: null, members: [] });
    const { data: team, error: teamErr } = await supabase
      .from("teams").select("id, name, owner_id, created_at").eq("id", me.team_id).single();
    if (teamErr) return json({ error: teamErr.message }, 500);

    const { data: members, error: memErr } = await supabase
      .from("profiles").select("id, email, full_name").eq("team_id", me.team_id);
    if (memErr) return json({ error: memErr.message }, 500);

    return json({
      team: { id: team.id, name: team.name, ownerId: team.owner_id, isOwner: team.owner_id === user.id },
      members: (members || []).map(m => ({ id: m.id, email: m.email, name: m.full_name, isOwner: m.id === team.owner_id })),
    });
  }

  return json({ error: "unknown action" }, 400);
});
