-- Seeds the community routines gallery, which has had zero real public
-- routines since it shipped (confirmed live: `select count(*) from
-- user_routines where is_public = true` returned 0). Both /routines.html
-- (logged-out) and chat.html's in-app "Community Gallery" tab have only
-- ever shown 4 hardcoded, explicitly-labeled "Starter ideas" -- this adds
-- real rows so forking actually does something.
--
-- Owned by the admin account (leer4030@gmail.com) -- the only account in
-- this project that makes sense as a template publisher. All 12 land
-- enabled = false, so run-routines' `where enabled = true` query (see
-- run-routines/index.ts) never picks them up and they never bill the
-- admin's own credits -- they exist only to be read (routines_public_read
-- RLS) and forked (fork_routine()), never to run on their own schedule.
-- fork_routine() already forks new copies as enabled = false too, so a
-- fork is inert until its new owner turns it on deliberately.
--
-- Prompts are written for what run-routines actually does: a single
-- generative Claude completion with no tool access (no web_search, no
-- live data) -- confirmed by reading run-routines/index.ts, which has no
-- TOOLS array unlike chat/index.ts. So these are knowledge/drafting tasks,
-- not "fetch today's news" tasks that would silently return stale info.

insert into public.user_routines
  (user_id, name, prompt, schedule, model, enabled, is_public, fork_count)
values
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Monday planning brief',
   'Write me a short Monday planning brief: 3 questions to clarify this week''s top priority, a suggested time-block structure for a focused workday, and one thing to deliberately NOT do this week. Keep it under 200 words, no fluff.',
   '0 7 * * 1', 'sonnet', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Daily writing prompt',
   'Give me one short-fiction writing prompt (2-3 sentences) in a genre I haven''t seen from you in the last few days, plus a single constraint (a word limit, a narrative rule, or a point-of-view restriction) to make it harder.',
   '0 8 * * *', 'haiku', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Weekly code-review checklist',
   'Generate a code review checklist for a backend pull request (security, error handling, test coverage, naming, and one category you pick based on common real-world review misses). Format as a markdown checklist I can paste into a PR description.',
   '0 9 * * 1', 'sonnet', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Interview prep: one hard question',
   'Give me one realistic, hard behavioral or system-design interview question for a senior software engineer role, plus a 4-bullet outline of what a strong answer would cover. Rotate the topic area each time rather than repeating the same theme.',
   '0 7 * * 1,3,5', 'sonnet', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   '5-minute language drill',
   'Give me 5 intermediate Spanish sentences to translate into English, followed by the answers. Vary the grammar focus each time (subjunctive, past tense, idioms, etc.) and briefly explain the trickiest one.',
   '0 8 * * *', 'haiku', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Weekly learning nudge',
   'Pick one underrated concept in distributed systems or algorithms I likely haven''t deeply studied, explain it in under 150 words at a practical (not academic) level, and give one concrete scenario where knowing it would have saved someone real debugging time.',
   '0 9 * * 3', 'opus', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Social post draft: build in public',
   'Draft a short, non-cringe "build in public" social media post (under 280 characters) about shipping a small improvement to a side project this week. Avoid generic hype language ("game-changer", "excited to announce") -- make it sound like a real person wrote it.',
   '0 16 * * 5', 'sonnet', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Decision-journal prompt',
   'Give me 3 short reflective journaling questions about a decision I made this week -- one about the reasoning at the time, one about what information I was missing, and one about what I''d do differently with what I know now.',
   '0 20 * * 0', 'haiku', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Explain it like I''m new to the field',
   'Pick one commonly-misunderstood concept in machine learning (rotate topics -- don''t repeat embeddings twice in a row) and explain it in plain language, as if to a competent engineer with zero ML background, in under 180 words with one concrete analogy.',
   '0 10 * * 2', 'sonnet', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Email tone check template',
   'Write a short, professional template for declining a meeting request without sounding dismissive, plus a 1-sentence version of the same thing for a Slack/chat context. No corporate jargon.',
   '0 8 * * 4', 'haiku', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Architecture trade-off of the week',
   'Describe one real architecture trade-off a backend team commonly faces (e.g. consistency vs. availability, monolith vs. microservices, sync vs. async processing -- rotate which one), lay out the strongest argument for each side in 2-3 sentences each, and state which one you''d actually pick for a 10-person startup team, with why.',
   '0 9 * * 5', 'opus', false, true, 0),
  ('422eecb9-2fb5-4e4e-9bd6-47f9433e8a56',
   'Quick budget gut-check',
   'Give me 3 pointed questions I should ask myself before an impulse purchase over $100, plus one short reframing exercise to tell the difference between a want and a need. Keep it under 120 words total.',
   '0 18 * * 0', 'haiku', false, true, 0);
