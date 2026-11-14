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
