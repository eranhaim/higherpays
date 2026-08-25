#!/bin/sh
# Nightly Postgres backup for the Docker stack.
#
# Dumps the database from the postgres container, keeps 30 local copies, and
# uploads to S3 when BACKUP_S3_BUCKET is set in .env (lifecycle rules on the
# bucket keep 30 daily and 12 monthly). Run from the repo root via cron:
#
#   15 3 * * * cd /home/ubuntu/higherpays && sh deploy/backup-postgres.sh >> /var/log/higherpays-backup.log 2>&1
#
# Restore with deploy/restore-postgres.sh. A backup that has never been restored
# is a hypothesis — restore-test it after setting this up and every quarter.
set -eu

CONTAINER="${PG_CONTAINER:-higherpays-pg}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/higherpays}"
KEEP_LOCAL="${KEEP_LOCAL:-30}"
BUCKET="${BACKUP_S3_BUCKET:-$(grep -E '^BACKUP_S3_BUCKET=' .env 2>/dev/null | cut -d= -f2- || true)}"

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/higherpays-$STAMP.dump"

# Custom format: compressed, and restorable table-by-table with pg_restore.
docker exec "$CONTAINER" pg_dump -U postgres -d higherpays --format=custom > "$FILE"
SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] dump is only ${SIZE} bytes — refusing to keep it" >&2
  rm -f "$FILE"
  exit 1
fi
echo "[backup] wrote $FILE ($SIZE bytes)"

if [ -n "$BUCKET" ]; then
  aws s3 cp "$FILE" "s3://$BUCKET/postgres/$(basename "$FILE")" --only-show-errors
  echo "[backup] uploaded to s3://$BUCKET/postgres/"
else
  echo "[backup] BACKUP_S3_BUCKET not set — local copy only"
fi

# Prune local copies beyond KEEP_LOCAL (newest first by name = by timestamp).
ls -1 "$BACKUP_DIR"/higherpays-*.dump 2>/dev/null | sort -r | tail -n +"$((KEEP_LOCAL + 1))" | while read -r old; do
  rm -f "$old"
  echo "[backup] pruned $old"
done
