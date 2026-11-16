#!/usr/bin/env bash
# Local test of the cooldown claim webhook-routine-trigger v2 relies on (2026-11-16).
# Needs PostgreSQL 16 server binaries and an OS user named "postgres" (run as root, or as
# that user). Starts a throwaway cluster, creates routine_webhooks with the live column
# types, then fires N sessions at the same row at the same instant.
#   * the v2 claim -- UPDATE ... WHERE id = $1 AND (last_triggered_at IS NULL OR
#     last_triggered_at <= cutoff) RETURNING id, which is what PostgREST runs for
#     .update(..).eq("id",..).or("last_triggered_at.is.null,last_triggered_at.lte.<cutoff>").select("id")
#     -- must hand a row back to exactly ONE session (the function writes literal values
#     in SET where this test increments; the WHERE is what is under test);
#   * the v1 shape (read, decide in the caller, unconditional UPDATE) must let EVERY session
#     through, so the test can see the bug it guards against.
# Usage: supabase/tests/webhook-cooldown-claim.sh [sessions, default 20]
set -euo pipefail
N="${1:-20}"
BIN=/usr/lib/postgresql/16/bin
D=$(mktemp -d /tmp/pgwh.XXXXXX); chown postgres "$D"; chmod 755 "$D"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$1"; else bash -c "$1"; fi; }
P="psql -h $D -p 54332 -U postgres -d postgres -v ON_ERROR_STOP=1 -At -q"
cleanup() { as_pg "$BIN/pg_ctl -D $D/data stop -m fast" >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
as_pg "$BIN/initdb -D $D/data -A trust" >/dev/null
as_pg "$BIN/pg_ctl -D $D/data -o '-p 54332 -k $D -c max_connections=200' -l $D/log start -w" >/dev/null
cat > "$D/schema.sql" <<'SQL'
create table public.routine_webhooks (
  id uuid primary key, routine_id uuid not null, token text not null unique,
  created_at timestamptz not null default now(), last_triggered_at timestamptz, trigger_count int not null default 0);
create table public.runs (hook uuid, at timestamptz default clock_timestamp());  -- one row per "the routine ran"
SQL
chmod 644 "$D/schema.sql"; as_pg "$P -f $D/schema.sql"
ID=11111111-1111-1111-1111-111111111111
reset() { as_pg "$P -c \"truncate public.runs; delete from public.routine_webhooks; insert into public.routine_webhooks (id, routine_id, token, last_triggered_at, trigger_count) values ('$ID', gen_random_uuid(), 'tok', $1, $2);\""; }
# Every session sleeps until the same wall-clock instant, then acts. The winner keeps its
# transaction open for 300 ms, so the others are certainly waiting on its row lock when it
# commits and must re-evaluate their WHERE against the committed row.
fire() {  # $1 = file holding the per-session SQL
  local start; start=$(as_pg "$P -c \"select (clock_timestamp() + interval '1.5 seconds')::text;\"")
  sed "s/__START__/$start/" "$1" > "$D/session.sql"; chmod 644 "$D/session.sql"
  for _ in $(seq "$N"); do as_pg "$P -f $D/session.sql" >/dev/null & done; wait
}
cat > "$D/v2.sql" <<SQL
select pg_sleep(greatest(0, extract(epoch from ('__START__'::timestamptz - clock_timestamp()))));
begin;
with claimed as (
  update public.routine_webhooks set last_triggered_at = clock_timestamp(), trigger_count = trigger_count + 1
   where id = '$ID' and (last_triggered_at is null or last_triggered_at <= clock_timestamp() - interval '30 seconds')
  returning id)
insert into public.runs (hook) select id from claimed;
select pg_sleep(0.3);
commit;
SQL
cat > "$D/v1.sql" <<SQL
select pg_sleep(greatest(0, extract(epoch from ('__START__'::timestamptz - clock_timestamp()))));
-- v1: read, decide in the caller, then an unconditional write
select (last_triggered_at is null or last_triggered_at <= clock_timestamp() - interval '30 seconds') as ok from public.routine_webhooks where id = '$ID' \gset
select pg_sleep(0.05);
\if :ok
  update public.routine_webhooks set last_triggered_at = clock_timestamp(), trigger_count = trigger_count + 1 where id = '$ID';
  insert into public.runs (hook) values ('$ID');
\endif
SQL
chmod 644 "$D"/v?.sql
runs()  { as_pg "$P -c 'select count(*) from public.runs;'"; }
count() { as_pg "$P -c 'select trigger_count from public.routine_webhooks;'"; }
fail=0; check() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (got $2, want $3)"; fail=1; fi; }

reset null 0;                                fire "$D/v2.sql"
check "v2 claim, never triggered, $N simultaneous sessions: exactly one run"   "$(runs)" 1
check "...and trigger_count moved by exactly one"                              "$(count)" 1
reset "now() - interval '5 minutes'" 7;      fire "$D/v2.sql"
check "v2 claim, cooldown expired, $N simultaneous sessions: exactly one run"  "$(runs)" 1
check "...and trigger_count moved by exactly one"                              "$(count)" 8
reset "now() - interval '5 seconds'" 7;      fire "$D/v2.sql"
check "v2 claim, inside the cooldown: nobody runs"                             "$(runs)" 0
check "...and trigger_count is untouched"                                      "$(count)" 7
fire "$D/v2.sql"
check "v2 claim, a second burst right after: still nobody runs"                "$(runs)" 0
reset null 0;                                fire "$D/v1.sql"
check "v1 shape (read then unconditional write): every session runs (the bug)" "$(runs)" "$N"
exit $fail
