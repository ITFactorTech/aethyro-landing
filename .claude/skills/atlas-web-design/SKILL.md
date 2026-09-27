---
name: atlas-web-design
description: Use when designing or rebuilding Aethyro marketing/landing pages (index.html, pricing.html, blog, new campaign pages) at a flagship/portfolio-grade bar — cinematic dark-tech visual language, purposeful motion, real copy, and strict a11y/perf budgets. Not for app/*.html (logged-in utility surfaces) or backend/edge-function work.
---

# ATLAS — Web Design & Build

Principal-level design discipline for Aethyro's public-facing pages. Treat every
build as portfolio work: composed, not decorated; systemized, not templated.

## Ground truth for this repo — read before applying anything below

This skill's source blueprint assumed a framework stack (Astro/Next/React,
componentization, a build step). **Aethyro has none of that** — per
`CLAUDE.md`: vanilla HTML/JS served directly from Cloudflare Workers,
git-push auto-deploy, no bundler. Adapt every "componentize" instruction
below to mean: shared CSS custom properties in a `<style>` block or a linked
`app/shared.css`-style file, and vanilla JS (`IntersectionObserver`, native
`<template>`, no framework). Don't introduce a build step to satisfy this
skill's aesthetic goals — the constraint is real, not an oversight.

**Existing brand tokens (`CLAUDE.md` → Conventions) are the starting system,
not a blank slate.** Dark theme: `--text:#f0f0f0`, `--muted:#888`,
`--surface:#141414`, `--border:#2a2a2a`, `--mono`, accent `#ff4d00`. Fonts:
Space Grotesk (display) + JetBrains Mono (mono), Google Fonts. Evolve this
system deliberately (new scale steps, elevation, motion tokens) — don't
replace the accent color or fonts without the user explicitly signing off,
since that's an established identity, not a placeholder.

## Operating principles

1. Brand before pixels — every decision traces back to a one-sentence brand
   essence (Aethyro's: sovereign, futurist AI infrastructure, not a chatbot
   toy).
2. Design in systems: tokens (color/type/spacing/radius/motion) before pages.
3. Motion with meaning — guide attention and reward interaction, never
   decorate for its own sake.
4. Performance is a design feature: LCP <2.5s, CLS <0.1, INP <200ms are
   budgeted like typography, not checked after the fact.
5. WCAG 2.2 AA is the floor.
6. One clear call to action per view.
7. Real copy always — no lorem ipsum, ever.
8. Ship production-grade: semantic, accessible, typo-free, deployable as-is
   (this repo has no CI/build gate — what you push is what's live).

## Sub-skills

Load the relevant step(s) for the task at hand; don't run all eight for a
one-section tweak.

### brand-extraction
Trigger: new page or section with no established narrative yet.
Workflow: distill brand essence in one sentence → 3 emotional adjectives + 2
to avoid → vocabulary/forbidden-words register.
Gate: every later decision on this page traces back to that one sentence.

### visual-system-design
Trigger: before any new layout, or when extending the token set.
Workflow: confirm/extend the existing token layer (see "Ground truth" above)
→ fluid type scale via `clamp()` → 4/8pt spacing → one signature visual
motif (Aethyro's existing devices: dark canvas + orange glow — extend this
motif rather than inventing a competing one per page).
Gate: a style tile of the tokens alone communicates the brand with zero
layout.

### art-direction
Trigger: hero sections, campaign/landing pages, "make it stunning" asks.
Workflow: storyboard the scroll narrative (promise → proof → depth → CTA) →
consistent imagery palette/lighting/grain → compose each screen like a
poster, one focal point → define the motion score.
Gate: a static screenshot of the hero is portfolio-worthy before any
animation is added.

### ux-architecture
Trigger: multi-page flows, navigation/sitemap changes.
Workflow: map user jobs-to-be-done → shortest happy path → nav depth ≤3
levels → design mobile/tablet/desktop as three deliberate states, not one
squeezed layout.
Gate: every page answers instantly — where am I, what is this, what do I do
next.

### copy-craft
Trigger: always — never placeholder copy, ever, on any page this skill
touches.
Workflow: value proposition before layout → headline = concrete outcome +
intrigue → body ≤25 words/block, one idea per sentence → CTA = verb + value
(never bare "Submit"/"Learn more").
Gate: reads well aloud; every sentence survives the deletion test.

### motion-and-interaction
Trigger: animation, scroll effects, micro-interactions, hero treatments.
Workflow: one easing family, duration scale (150/300/600/900ms), one
signature transition → choreograph entrances (staggered OR masked OR
parallax — not all three at once) → `transform`/`opacity` only, GPU-friendly
→ unconditionally honor `prefers-reduced-motion` with an equally-designed
static fallback.
Tooling: native CSS animations + `IntersectionObserver`. No animation
library — this repo ships zero JS dependencies; don't add one for this.
Gate: 60fps on a mid-range phone; reduced-motion users get a real fallback,
not a broken one.

### production-engineering (adapted for this repo's actual stack)
Trigger: implementing any design; "build it," "make it real."
Workflow: (1) plain HTML/CSS/JS, no framework, no bundler, no build step —
this is a hard constraint, not a starting option; (2) share tokens via CSS
custom properties, either inline `<style>` or a shared stylesheet link, not
a component library; (3) semantic HTML, landmarks, full keyboard/focus
order, real `alt` text; (4) images: AVIF/WebP with explicit `width`/`height`,
`loading="lazy"` below the fold; (5) fonts: `font-display: swap`, system
fallback stack; (6) verify LCP/CLS/INP by hand (browser DevTools Lighthouse
panel — there's no CI performance gate in this repo, so this step doesn't
happen unless you do it).
Gate: zero console errors, passes a manual axe/Lighthouse pass, meets the
performance budget, no known-violation waivers.

### design-qa-and-polish
Trigger: before calling any page done — mandatory, always last.
Workflow: squint test for hierarchy → check at 320/768/1024/1440/1920px →
every interactive state (hover/focus-visible/active/disabled/loading/empty/
error) → proofread copy against the brand register → contrast-check text
and meaningful non-text UI → verify meta (title, description, OG image,
favicon) — and for `app/*.html` specifically, confirm
`<meta name="robots" content="noindex,nofollow">` is still present (see
CLAUDE.md Conventions; it's intentional, don't strip it).
Gate: nothing ships until it would go in your own portfolio.

## Six-phase delivery process

1. **Discovery** — brand brief before any design decision.
2. **Definition** — sitemap, flows, content inventory, one-sentence concept.
3. **Design** — tokens → key screens (hero, feature, proof, conversion) →
   templates. Stills before motion.
4. **Build** — implement directly in the target `.html` file; optimize
   assets as they're added, not at the end.
5. **Harden** — a11y, performance, meta/SEO, cross-browser, responsive,
   copy QA.
6. **Ship** — this repo auto-deploys on git push to the PR/main branch
   (Cloudflare Workers git integration) — there is no separate deploy step.
   Follow this repo's existing branch → commit → push → draft PR →
   `subscribe_pr_activity` workflow; don't push straight to `main`.

## Non-negotiables

- Never ship a default-framework look, default blue, or unmodified CSS
  reset aesthetic.
- Never leave an unstyled focus state, a broken link, or an unoptimized
  image.
- Never let a meaningful element fail contrast.
- Never invent brand-identity changes (accent color, fonts, tone) without
  the user's explicit sign-off — extend the system, don't replace it
  silently.
- Explain rationale and trade-offs when presenting work; don't just deliver
  a diff with no reasoning.

## Escalate to the user when

- The brand direction itself would change (not just extend).
- Copy needs facts/claims that don't exist yet (see CLAUDE.md's fabricated-
  testimonials P0 — don't repeat that mistake: never invent quotes, personas,
  or stats to fill a section).
- A third-party asset, font license, or paid tool would be needed.
- Quality-vs-speed is a real trade-off worth surfacing rather than deciding
  silently.

## Quality scorecard — self-grade before calling anything done

| Dimension | Threshold |
|---|---|
| Brand fidelity | Every section traces to the brand brief |
| Visual hierarchy | Squint test passes on every view |
| Motion | 60fps, reduced-motion honored, purposeful only |
| Accessibility | WCAG 2.2 AA, zero failures |
| Performance | LCP <2.5s, CLS <0.1, INP <200ms |
| Copy | Deletion test + brand register, all blocks |
| Engineering | Zero console errors, no framework/build-step added |
| Responsiveness | No layout breaks 320–1920px |

Below full marks = not finished, it's a draft.
