# signup-gate: switching it on, checking it, switching it off

The function and the signup page ship **inert**. Nothing changes for anyone until all
three of these exist: a site key in `app/config.js`, the `TURNSTILE_SECRET_KEY` secret,
and the hook enabled in the Supabase dashboard. Do them in this order.

## Switch on
1. **Cloudflare dashboard -> Turnstile -> Add widget.** Name it "Aethyro signup",
   hostnames `aethyro.com` and `www.aethyro.com`, mode **Managed**. Copy the **Site key**
   (public) and the **Secret key**.
2. **Site key -> `app/config.js`:** set `window.AETHYRO_TURNSTILE_SITEKEY = "<site key>";`
   and merge. The email signup form now shows the widget and sends the token; the hook is
   not on yet, so nothing is refused.
3. **Supabase dashboard -> Edge Functions -> Secrets:** add `TURNSTILE_SECRET_KEY` = the
   secret key.
4. **Supabase dashboard -> Authentication -> Hooks -> Before User Created:** type **HTTP**,
   URL `https://uzmdqbtflcpikjdrggqc.supabase.co/functions/v1/signup-gate`. Click
   **Generate secret**, copy it, add it as the Edge Function secret
   `SIGNUP_GATE_HOOK_SECRET` (optional but recommended: it makes the function accept only
   Supabase's own calls), then save/enable the hook.

## Check it
- A direct call with no token must now be refused:
  `curl -s -X POST https://uzmdqbtflcpikjdrggqc.supabase.co/auth/v1/signup -H "apikey: <anon key>" -H "Content-Type: application/json" -d '{"email":"check-1@example.org","password":"a-long-unique-passphrase-91"}'`
  -> HTTP 400 with the "human check" message, and no user created.
- One real signup in a normal browser (use a plus address) must still work end to end.
- Google / GitHub signup and every login must be unaffected.

## Switch off (any one is enough, fastest first)
1. Dashboard -> Authentication -> Hooks -> Before User Created -> disable.
2. Remove the `TURNSTILE_SECRET_KEY` secret (the function then allows everything).
3. Blank `window.AETHYRO_TURNSTILE_SITEKEY` in `app/config.js` (hides the widget; with the hook
   still on, email signups would then be refused, so do 1 or 2 first).

## Behaviour to know
- Refuses only an email signup with no token or a token Cloudflare rejects. A Cloudflare
  outage, a 5xx, a timeout, or "invalid/missing secret" all FAIL OPEN and are logged.
- Visitors whose browser blocks the widget see a message offering Google / GitHub signup.
- Existing accounts, logins and password resets are never touched by this hook.
