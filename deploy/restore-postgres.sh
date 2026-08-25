#!/bin/sh
# Restore a dump from deploy/backup-postgres.sh into the postgres container.
#
#   sh deploy/restore-postgres.sh /var/backups/higherpays/higherpays-<stamp>.dump [target_db]
#
# Without a target database this REPLACES the live `higherpays` database:
# stop the API first (`docker compose stop backend`), restore, then
# `docker compose start backend`. With a target database (e.g.
# `higherpays_restore_test`) it restores side by side, which is how a
# restore test is done without touching production data.
set -eu

DUMP="${1:?usage: restore-postgres.sh <dump file> [target_db]}"
TARGET="${2:-higherpays}"
CONTAINER="${PG_CONTAINER:-higherpays-pg}"

[ -s "$DUMP" ] || { echo "[restore] $DUMP is missing or empty" >&2; exit 1; }

docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$TARGET\";" -c "CREATE DATABASE \"$TARGET\";"
docker exec -i "$CONTAINER" pg_restore -U postgres -d "$TARGET" --no-owner --role=postgres < "$DUMP"

# The app role's grants are per database; re-apply them on the restored one.
docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT ON DATABASE \"$TARGET\" TO hp_app;"
docker exec -i "$CONTAINER" psql -U postgres -d "$TARGET" -v ON_ERROR_STOP=1 -q <<'EOSQL'
GRANT USAGE ON SCHEMA public TO hp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hp_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO hp_app;
EOSQL

TABLES=$(docker exec "$CONTAINER" psql -U postgres -d "$TARGET" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
TX=$(docker exec "$CONTAINER" psql -U postgres -d "$TARGET" -tAc "SELECT count(*) FROM transactions")
echo "[restore] $TARGET: $TABLES tables, $TX transactions"
