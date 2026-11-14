#!/usr/bin/env bash
# Local test for 20261114200000 + 20261114210000 (strip the Turnstile token from auth.users).
# Needs PostgreSQL 16 server binaries and an OS user named "postgres" (run as root, or as
# that user). Reproduces what Supabase Auth really does: INSERT the user, then write the whole
# row again from its in-memory copy. Checks the old (INSERT-only) trigger LEAVES the token
# after that second write (so the test can see the bug), and the new trigger removes it, also
# from rows that already had it, without touching other metadata or ordinary updates.
# Usage: supabase/tests/strip-human-check-token.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OLD="$HERE/../migrations/20261114200000_strip_signup_human_check_token.sql"
NEW="$HERE/../migrations/20261114210000_strip_human_check_token_on_update_too.sql"
BIN=/usr/lib/postgresql/16/bin
D=$(mktemp -d /tmp/pgstrip.XXXXXX); chown postgres "$D"; chmod 755 "$D"
cp "$OLD" "$D/old.sql"; cp "$NEW" "$D/new.sql"; chmod 644 "$D"/*.sql
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else bash -c "$1"; fi; }
P="psql -h $D -p 54331 -U postgres -d postgres -v ON_ERROR_STOP=1 -At -q"
cleanup() { as_pg "$BIN/pg_ctl -D $D/data stop -m fast" >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
as_pg "$BIN/initdb -D $D/data -A trust" >/dev/null
as_pg "$BIN/pg_ctl -D $D/data -o '-p 54331 -k $D' -l $D/log start -w" >/dev/null
cat > "$D/schema.sql" <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique not null, raw_user_meta_data jsonb not null default '{}',
                         confirmation_token text, last_sign_in_at timestamptz, updated_at timestamptz default now());
-- a row that already carries the token, from before any trigger existed
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-000000000001','legacy@x.test','{"cf_turnstile_token":"0.legacy","keep":"yes"}');
SQL
chmod 644 "$D/schema.sql"
as_pg "$P -f $D/schema.sql && $P -f $D/old.sql"
has()  { as_pg "$P -c \"select raw_user_meta_data ? 'cf_turnstile_token' from auth.users where email='$1';\""; }
meta() { as_pg "$P -c \"select raw_user_meta_data - 'cf_turnstile_token' from auth.users where email='$1';\""; }
ins()  { as_pg "$P -c \"insert into auth.users (id,email,raw_user_meta_data) values (gen_random_uuid(),'$1','{\\\"cf_turnstile_token\\\":\\\"0.tok\\\",\\\"signup_referrer\\\":\\\"https://aethyro.com/\\\"}');\""; }
# what Auth does right after the insert: a full-row write from its in-memory copy
regrow() { as_pg "$P -c \"update auth.users set raw_user_meta_data='{\\\"cf_turnstile_token\\\":\\\"0.tok\\\",\\\"signup_referrer\\\":\\\"https://aethyro.com/\\\",\\\"email_verified\\\":false}', confirmation_token='x', updated_at=now() where email='$1';\""; }
fail=0; check() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $2, want $3)"; fail=1; fi; }
ins old.a@x.test; check "OLD trigger strips at INSERT"                          "$(has old.a@x.test)" f
regrow old.a@x.test; check "OLD trigger: token comes back on the follow-up write (the bug)" "$(has old.a@x.test)" t
check "legacy row still has the token before the new migration"                 "$(has legacy@x.test)" t
as_pg "$P -f $D/new.sql"
check "NEW migration cleans rows that already had the token"                    "$(has legacy@x.test)" f
check "...and keeps the other metadata"                                         "$(meta legacy@x.test)" '{"keep": "yes"}'
check "...and the previously regrown row is cleaned too"                        "$(has old.a@x.test)" f
ins new.a@x.test;   check "NEW: stripped at INSERT"                             "$(has new.a@x.test)" f
regrow new.a@x.test; check "NEW: stripped on the follow-up full-row write"      "$(has new.a@x.test)" f
check "NEW: other metadata survives both writes" "$(meta new.a@x.test)" '{"email_verified": false, "signup_referrer": "https://aethyro.com/"}'
as_pg "$P -c \"update auth.users set last_sign_in_at=now() where email='new.a@x.test';\""
check "NEW: an ordinary update still works and leaves metadata alone"           "$(meta new.a@x.test)" '{"email_verified": false, "signup_referrer": "https://aethyro.com/"}'
check "function is not callable by anon / authenticated"  "$(as_pg "$P -c \"select has_function_privilege('anon','public.strip_signup_human_check_token()','EXECUTE')::text || has_function_privilege('authenticated','public.strip_signup_human_check_token()','EXECUTE')::text;\"")" falsefalse
# mutation: drop the UPDATE part of the trigger and the follow-up write must leak again
as_pg "$P -c \"drop trigger aa_strip_signup_human_check_token on auth.users; create trigger aa_strip_signup_human_check_token before insert on auth.users for each row execute function public.strip_signup_human_check_token();\""
ins mut.a@x.test; regrow mut.a@x.test
check "MUTATION (INSERT-only trigger): the leak is detectable"                  "$(has mut.a@x.test)" t
exit $fail
