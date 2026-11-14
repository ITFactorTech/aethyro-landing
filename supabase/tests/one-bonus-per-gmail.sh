#!/usr/bin/env bash
# Local test for 20261114190000_one_signup_bonus_per_normalized_gmail.sql.
# Needs PostgreSQL 16 server binaries and an OS user named "postgres" (run as root, or
# as that user). Builds a throwaway cluster in a temp dir with a minimal auth.users /
# credit_ledger / bonus_blocked_domains, loads the migration, then checks:
#   1. sequential cases (dot variant, googlemail + tag, different mailbox, blocked domain)
#   2. concurrency: a second signup on the same mailbox, started while the first is still
#      uncommitted, must wait for it and get NO bonus (and does get one if the advisory
#      lock line is deleted, proving the test can detect the race).
# Usage: supabase/tests/one-bonus-per-gmail.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations/20261114190000_one_signup_bonus_per_normalized_gmail.sql"
BIN=/usr/lib/postgresql/16/bin
D=$(mktemp -d /tmp/pgbonus.XXXXXX); chown postgres "$D"; chmod 755 "$D"
cp "$MIG" "$D/mig.sql"; chmod 644 "$D/mig.sql"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else bash -c "$1"; fi; }
P="psql -h $D -p 54330 -U postgres -d postgres -v ON_ERROR_STOP=1 -At -q"
cleanup() { as_pg "$BIN/pg_ctl -D $D/data stop -m fast" >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
as_pg "$BIN/initdb -D $D/data -A trust" >/dev/null
as_pg "$BIN/pg_ctl -D $D/data -o '-p 54330 -k $D' -l $D/log start -w" >/dev/null
cat > "$D/schema.sql" <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, email text unique not null);
create table public.credit_ledger (id bigserial primary key, user_id uuid not null, delta int not null, reason text not null);
create table public.bonus_blocked_domains (domain text primary key, reason text, created_at timestamptz default now());
insert into public.bonus_blocked_domains (domain) values ('fldubai.com');
SQL
echo "create trigger g after insert on auth.users for each row execute function public.grant_signup_bonus();" > "$D/trg.sql"
chmod 644 "$D"/*.sql
as_pg "$P -f $D/schema.sql && $P -f $D/mig.sql && $P -f $D/trg.sql"
bonus() { as_pg "$P -c \"select count(l.id) from auth.users u left join public.credit_ledger l on l.user_id=u.id and l.reason='signup_bonus' where u.email='$1';\""; }
ins()   { as_pg "$P -c \"insert into auth.users values (gen_random_uuid(),'$1');\" >/dev/null"; }
fail=0; check() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $2, want $3)"; fail=1; fi; }
for e in seq.a@gmail.com seqa+x@googlemail.com seqb@gmail.com bot@fldubai.com other.a@outlook.com othera@outlook.com; do ins "$e"; done
check "first Gmail on a mailbox gets the bonus"            "$(bonus seq.a@gmail.com)" 1
check "googlemail + tag variant gets none"                  "$(bonus seqa+x@googlemail.com)" 0
check "a different Gmail mailbox gets one"                  "$(bonus seqb@gmail.com)" 1
check "blocked domain gets none"                            "$(bonus bot@fldubai.com)" 0
check "dots are NOT normalized outside Gmail (outlook)"     "$(bonus other.a@outlook.com)$(bonus othera@outlook.com)" 11
race() { # $1,$2 = two variants of one mailbox; returns the second one's bonus count
  as_pg "$P -c \"begin; insert into auth.users values (gen_random_uuid(),'$1'); select pg_sleep(3); commit;\" >/dev/null" & sleep 1
  ins "$2"; wait; bonus "$2"
}
check "concurrent second signup waits and gets none"        "$(race conc.a@gmail.com conca+2@googlemail.com)" 0
sed -i '/pg_advisory_xact_lock/d' "$D/mig.sql"; as_pg "$P -f $D/mig.sql"
check "MUTATION (lock removed): the race is detectable"      "$(race race.b@gmail.com raceb+2@googlemail.com)" 1
exit $fail
