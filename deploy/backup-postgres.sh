#!/bin/sh
# Nightly Postgres backup for the HigherPays database.
#
# Dumps RDS when BACKUP_DATABASE_URL or MIGRATIONS_DATABASE_URL is set, and
# otherwise falls back to the local postgres container. Keeps 30 local copies
# and uploads to S3 when BACKUP_S3_BUCKET is set in .env (lifecycle rules on
# the bucket keep 30 daily and 12 monthly). Run from the repo root via cron:
#
#   15 3 * * * cd /home/ubuntu/higherpays && sh deploy/backup-postgres.sh >> /var/log/higherpays-backup.log 2>&1
#
# Restore with deploy/restore-postgres.sh. A backup that has never been restored
# is a hypothesis — restore-test it after setting this up and every quarter.
set -eu

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

CONTAINER="${PG_CONTAINER:-higherpays-pg}"
BACKUP_DIR="${BACKUP_DIR:-${HOME}/backups/higherpays}"
KEEP_LOCAL="${KEEP_LOCAL:-30}"
BUCKET="${BACKUP_S3_BUCKET:-$(grep -E '^BACKUP_S3_BUCKET=' .env 2>/dev/null | cut -d= -f2- || true)}"
ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_URL="${BACKUP_DATABASE_URL:-}"
if [ -z "$BACKUP_URL" ]; then
  BACKUP_URL="$(grep -E '^MIGRATIONS_DATABASE_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' || true)"
fi
# This parameter is for node-postgres only; libpq rejects unknown URL options.
BACKUP_URL="$(printf '%s' "$BACKUP_URL" | sed 's/[&?]uselibpqcompat=true//')"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/higherpays-$STAMP.dump"

# Custom format: compressed, and restorable table-by-table with pg_restore.
if [ -n "$BACKUP_URL" ]; then
  docker run --rm --network host postgres:16-alpine \
    pg_dump "$BACKUP_URL" --format=custom > "$FILE"
else
  docker exec "$CONTAINER" pg_dump -U postgres -d higherpays --format=custom > "$FILE"
fi
SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] dump is only ${SIZE} bytes — refusing to keep it" >&2
  rm -f "$FILE"
  exit 1
fi
chmod 600 "$FILE"
echo "[backup] wrote $FILE ($SIZE bytes)"

if [ -n "$BUCKET" ]; then
  export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}"
  export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}"
  export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
  if [ -n "$ENDPOINT" ]; then
    docker run --rm \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
      -v "$BACKUP_DIR:/backup:ro" amazon/aws-cli:latest \
      s3 --endpoint-url "$ENDPOINT" cp "/backup/$(basename "$FILE")" \
      "s3://$BUCKET/postgres/$(basename "$FILE")" --only-show-errors
  else
    aws s3 cp "$FILE" "s3://$BUCKET/postgres/$(basename "$FILE")" --only-show-errors
  fi
  echo "[backup] uploaded to s3://$BUCKET/postgres/"
else
  echo "[backup] BACKUP_S3_BUCKET not set — local copy only"
fi

# Prune local copies beyond KEEP_LOCAL (newest first by name = by timestamp).
ls -1 "$BACKUP_DIR"/higherpays-*.dump 2>/dev/null | sort -r | tail -n +"$((KEEP_LOCAL + 1))" | while read -r old; do
  rm -f "$old"
  echo "[backup] pruned $old"
done
