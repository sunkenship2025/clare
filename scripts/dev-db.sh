#!/bin/sh
# Throwaway local Postgres for clare development (never touches your other databases).
#   scripts/dev-db.sh start | stop | reset | psql
#   CLARE_DB=clare_mine scripts/dev-db.sh start   # extra, separate database on the same server
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="$ROOT/.dev/pg"
PORT=${CLARE_PG_PORT:-54329}
DB=${CLARE_DB:-clare}
PGBIN=${PGBIN:-$(ls -d /opt/homebrew/opt/postgresql@17/bin /usr/lib/postgresql/17/bin 2>/dev/null | head -1)}
[ -n "$PGBIN" ] || PGBIN=$(dirname "$(command -v initdb)")

case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p "$ROOT/.dev"
      "$PGBIN/initdb" -D "$DATA" -U "$(whoami)" --auth=trust >/dev/null
    fi
    "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$ROOT/.dev/pg.log" status >/dev/null 2>&1 ||
      "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$ROOT/.dev/pg.log" -w start >/dev/null
    if ! "$PGBIN/psql" -h localhost -p "$PORT" -d "$DB" -c 'select 1' >/dev/null 2>&1; then
      "$PGBIN/createdb" -h localhost -p "$PORT" "$DB"
      for f in "$ROOT"/supabase/migrations/*.sql; do
        "$PGBIN/psql" -q -v ON_ERROR_STOP=1 -h localhost -p "$PORT" -d "$DB" -f "$f"
      done
    fi
    echo "postgres://localhost:$PORT/$DB"
    ;;
  stop) "$PGBIN/pg_ctl" -D "$DATA" -w stop >/dev/null && echo stopped ;;
  reset)
    "$PGBIN/pg_ctl" -D "$DATA" -w stop >/dev/null 2>&1 || true
    rm -rf "$DATA" && exec "$0" start
    ;;
  psql) shift; exec "$PGBIN/psql" -h localhost -p "$PORT" -d "$DB" "$@" ;;
  *) echo "usage: $0 start|stop|reset|psql" >&2; exit 2 ;;
esac
