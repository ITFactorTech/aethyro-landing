# Check 16 -- the set of ways to create an account has not changed

**Why this exists.** Every control on sign-up (the Turnstile hook, the bonus rules, the
blocklist) assumes a known set of ways to create an `auth.users` row. A provider switched on
in the dashboard (anonymous sign-ins, phone, SAML, another OAuth provider) adds a path those
controls were never designed or tested for, and nothing in the repo records it: it is an Auth
dashboard setting. Found 2026-11-16 by the `backend-reviewer` sweep while reading the
sign-up gate: the gate's behaviour per provider is a design decision that only holds while
the provider list stays as it is.

## Run it (read-only, public endpoint, no account needed)

```bash
URL=https://uzmdqbtflcpikjdrggqc.supabase.co
ANON=$(grep -o 'eyJ[A-Za-z0-9._-]*' app/config.js | head -1)   # the public anon key
curl -s "$URL/auth/v1/settings" -H "apikey: $ANON" | python3 -c '
import sys,json
d=json.load(sys.stdin); ext=d["external"]
print("enabled:", sorted(k for k,v in ext.items() if v is True))
print({k: d.get(k) for k in ("disable_signup","saml_enabled","phone_autoconfirm","sms_provider")})
print("anonymous_users:", ext.get("anonymous_users"), "phone:", ext.get("phone"))'
```

## What "clean" looks like (as of 2026-11-16)

- `enabled: ['email', 'github', 'google']` and nothing else.
- `anonymous_users: False`, `phone: False`, `saml_enabled: False`.
- `disable_signup: False` (sign-ups are open on purpose).

## What a mismatch looks like

Any extra provider, or `anonymous_users` / `phone` / `saml_enabled` true. Do not "fix" it
from a sweep (the setting is dashboard-only and may be intentional): report it to the owner
with the diff, and treat the sign-up controls as unverified for that provider until they
have been tested for it (hook payload, bonus trigger, farm detector `checks/14`).
`sms_provider: twilio` appearing while `phone` is false is only a stored setting, not a path.

## History

- 2026-11-16: first run, clean (enabled = email, github, google; anonymous/phone/SAML off).
