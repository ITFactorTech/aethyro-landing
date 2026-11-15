# Flow: signup human check (Cloudflare Turnstile) -- browser test

`ui-test.cjs` drives `app/signup.html` and `app/login.html` in Chromium against a local
static server with Supabase and Turnstile mocked at the network layer (Playwright route
interception), so it needs no account and no network. Run from the repo root:

    python3 -m http.server 8765 &
    node .claude/skills/probe/flows/signup-human-check/ui-test.cjs

Covers: widget hidden and no token sent when no site key is configured; with a key, the
token rides in `user_metadata.cf_turnstile_token` for both password and magic-link signup;
an unsolved or blocked widget makes no request and shows a clear message; the widget is
reset after each use; the login-page magic link sends `create_user:false`.

Live regression (needs the hook enabled; see `supabase/functions/signup-gate/README.md`):
a direct `POST /auth/v1/signup` with no token must be refused (400), a normal browser signup
must succeed, OAuth signup and every login must be unaffected.

## Live production run (2026-11-15, `probe` sweep)

On https://aethyro.com Turnstile's `api.js` loads and the real widget renders ("Verify you are
human", about 73 px high), but the widget's challenge call to `challenges.cloudflare.com` cannot
complete from this sandbox (egress is blocked: do not work around it), so no token is ever
issued. What is testable and passed: the page loads at 1440 and 390 with no uncaught errors and no
horizontal overflow; submitting the email form or the magic link without a token shows "Please
complete the human check above, then try again." and makes **zero** `/auth/v1/signup|otp` calls;
with the Cloudflare script aborted (a blocker) it shows "The human check couldn't load. Turn off
blockers for this page and reload, or sign up with Google or GitHub."; the Google and GitHub buttons
issue `GET /auth/v1/authorize?provider=...` (abort it, do not complete OAuth). The breached-password
check sits *behind* the token check, so on production reach it by replacing the Turnstile script with
a stub via `page.route` (the stub calls the callback with a fake token and never contacts Cloudflare;
the fake token must never reach Supabase: abort `/auth/v1/signup|otp` at the network layer, and
confirm with SQL that no `auth.users` row appeared). Do not block `challenge-platform` broadly: that
pattern also blocks Cloudflare's own widget assets; scope it to `aethyro.com/cdn-cgi/challenge-platform`.
Whether the Auth hook is enabled cannot be tested from the page: use
`site-guardian/checks/15-auth-hook-actually-invoked.md`.
