-- Drop the in-app community forum (forum_threads/forum_posts/forum_reports
-- + their rate-limiting/reply-count triggers). Found by a site-guardian
-- sweep on 2026-09-28: app/community.html (the only consumer of this
-- schema) was fully built and originally linked from the dashboard back
-- in the pre-"Aethyro Cloud" era (added 2026-05-31, commit message says
-- "+ dashboard link"), but that dashboard link was later repointed to a
-- Discord invite during the Cloud pivot -- the forum code and its tables
-- were simply never cleaned up when that happened. Removed on explicit
-- instruction after confirming the page's origin via git history.
--
-- Confirmed safe before dropping:
--  - forum_threads and forum_posts both had zero rows, ever
--  - app/community.html (being deleted in the same change) was the only
--    code anywhere in this repo that referenced any of these tables/RPCs
--  - the 3 trigger functions (forum_after_post, forum_rate_post,
--    forum_rate_thread) only exist to serve triggers on these tables

DROP TABLE IF EXISTS public.forum_reports;
DROP TABLE IF EXISTS public.forum_posts;
DROP TABLE IF EXISTS public.forum_threads;

DROP FUNCTION IF EXISTS public.forum_after_post();
DROP FUNCTION IF EXISTS public.forum_rate_post();
DROP FUNCTION IF EXISTS public.forum_rate_thread();
