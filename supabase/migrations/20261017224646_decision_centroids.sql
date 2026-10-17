-- Generalizes classify_router_tier()'s proven nearest-centroid pattern
-- (Phase 3, 2026-09-28 -- the embedding classifier behind chat's
-- model:"auto" routing) into a reusable typed-decision primitive that a
-- future fast/cheap decision can plug into, instead of hand-rolling its own
-- centroid table + SQL function the way classify_router_tier did.
--
-- Deliberately does NOT touch model_router_centroids or classify_router_tier
-- -- both stay exactly as they are, proven and live-billing-adjacent. This
-- migration is purely additive infrastructure for *future* decision types;
-- nothing calls classify_decision() yet.
--
-- The one thing this adds beyond a renamed copy of the router's own
-- mechanism: classify_decision() also returns `margin` -- the gap between
-- the best and second-best cosine distance among that decision_type's own
-- centroids. A small margin means the fast classifier found two labels
-- almost equally plausible (a genuinely hard/boundary case); a large margin
-- means it's confident. That margin is what turns this from "a classifier"
-- into a real LLM/JEV hybrid primitive -- a future caller can defer to the
-- full LLM whenever the margin is small, and trust the fast label
-- otherwise, the same escalation pattern a dedicated "JEV" encoder would
-- need its own calibration step to produce.
--
-- Deliberately does NOT bake in a "confident: true/false" cutoff. There is
-- no real calibration data yet for what a good margin threshold is -- that
-- would need the same per-decision-type leave-one-out validation the
-- router's own 3 tiers got on ~25 curated examples each before anyone
-- trusted its 94.7% accuracy figure. Baking in an arbitrary number (e.g.
-- "confident if margin >= 0.08") here would look calibrated without being
-- calibrated. Callers get the raw margin and decide their own threshold
-- once they have real validation data for their own decision type.

create table if not exists public.decision_centroids (
  decision_type text not null,
  label text not null,
  centroid vector(1024) not null,
  updated_at timestamptz not null default now(),
  primary key (decision_type, label)
);

comment on table public.decision_centroids is
  'Generalized nearest-centroid typed-decision store. One row per (decision_type, label). See classify_decision(). model_router_centroids/classify_router_tier are left as their own separate, proven, unmodified mechanism -- not migrated here.';

revoke all on public.decision_centroids from public, anon, authenticated;
grant all on public.decision_centroids to service_role, postgres;

create or replace function public.classify_decision(p_decision_type text, p_embedding vector)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with ranked as (
    select
      label,
      embedding <=> p_embedding as dist,
      row_number() over (order by embedding <=> p_embedding asc) as rn
    from (
      select label, centroid as embedding
      from public.decision_centroids
      where decision_type = p_decision_type
    ) c
  ),
  top2 as (
    select
      max(label) filter (where rn = 1) as best_label,
      max(dist) filter (where rn = 1) as best_dist,
      max(dist) filter (where rn = 2) as second_dist
    from ranked
    where rn <= 2
  )
  select case
    when best_label is null then null
    else jsonb_build_object(
      'label', best_label,
      'margin', case when second_dist is null then null
                     else round((second_dist - best_dist)::numeric, 4) end
    )
  end
  from top2;
$function$;

comment on function public.classify_decision(text, vector) is
  'Generalized version of classify_router_tier() for an arbitrary decision_type. Returns {"label","margin"} (margin null if fewer than 2 centroids exist for that decision_type, whole result null if zero exist). service_role-only -- same lockdown as classify_router_tier, applied up front this time per the lesson in that function''s own incident history.';

revoke all on function public.classify_decision(text, vector) from public, anon, authenticated;
grant execute on function public.classify_decision(text, vector) to service_role, postgres;
