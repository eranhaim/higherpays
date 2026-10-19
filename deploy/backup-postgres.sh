#!/bin/sh
# PostgreSQL backup for the HigherPays database.
#
# Dumps RDS when BACKUP_DATABASE_URL or MIGRATIONS_DATABASE_URL is set, and
# otherwise falls back to the local postgres container. Keeps 30 local copies
# and uploads to S3 when BACKUP_S3_BUCKET is set in .env (lifecycle rules on
# the bucket keep 30 daily and 12 monthly). The weekly systemd service can
# also upload a dump and its manifest to Google Drive through rclone.
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
DRIVE_UPLOAD="${BACKUP_GOOGLE_DRIVE_UPLOAD:-false}"
DRIVE_REMOTE="${BACKUP_GOOGLE_DRIVE_REMOTE:-}"
RUN_LABEL="${BACKUP_RUN_LABEL:-}"
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
MANIFEST="$BACKUP_DIR/higherpays-$STAMP.manifest.json"
TEMP_FILE="$FILE.tmp.$$"
TEMP_MANIFEST="$MANIFEST.tmp.$$"
trap 'rm -f "$TEMP_FILE" "$TEMP_MANIFEST"' EXIT HUP INT TERM

# Custom format: compressed, and restorable table-by-table with pg_restore.
if [ -n "$BACKUP_URL" ]; then
  docker run --rm --network host postgres:16-alpine \
    pg_dump "$BACKUP_URL" --format=custom > "$TEMP_FILE"
else
  docker exec "$CONTAINER" pg_dump -U postgres -d higherpays --format=custom > "$TEMP_FILE"
fi
SIZE=$(wc -c < "$TEMP_FILE")
if [ "$SIZE" -lt 1024 ]; then
  echo "[backup] dump is only ${SIZE} bytes — refusing to keep it" >&2
  exit 1
fi
mv "$TEMP_FILE" "$FILE"
chmod 600 "$FILE"
CHECKSUM=$(sha256sum "$FILE" | awk '{print $1}')
cat > "$TEMP_MANIFEST" <<EOF
{
  "created_at_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backup_file": "$(basename "$FILE")",
  "sha256": "$CHECKSUM",
  "bytes": $SIZE,
  "format": "pg_dump custom",
  "restore": "Verify with sha256sum, then use deploy/restore-postgres.sh <dump> <non-production-target-db>."
}
EOF
mv "$TEMP_MANIFEST" "$MANIFEST"
chmod 600 "$MANIFEST"
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

case "$DRIVE_UPLOAD" in
  false|"")
    echo "[backup] Google Drive upload disabled — local dump and manifest retained"
    ;;
  true)
    [ -n "$DRIVE_REMOTE" ] || {
      echo "[backup] BACKUP_GOOGLE_DRIVE_REMOTE is required when Drive upload is enabled" >&2
      exit 1
    }
    case "$DRIVE_REMOTE" in
      *:) ;;
      *)
        echo "[backup] BACKUP_GOOGLE_DRIVE_REMOTE must end with a colon" >&2
        exit 1
        ;;
    esac
    command -v rclone >/dev/null 2>&1 || {
      echo "[backup] rclone is required for Google Drive upload" >&2
      exit 1
    }
    DRIVE_FOLDER="$(date -u +%F)"
    if [ -n "$RUN_LABEL" ]; then
      DRIVE_FOLDER="$DRIVE_FOLDER/$RUN_LABEL"
    fi
    DRIVE_DESTINATION="${DRIVE_REMOTE}${DRIVE_FOLDER}"
    rclone copy "$FILE" "$DRIVE_DESTINATION" --checksum --retries 3 --low-level-retries 10
    rclone copy "$MANIFEST" "$DRIVE_DESTINATION" --checksum --retries 3 --low-level-retries 10
    echo "[backup] uploaded dump and manifest to Google Drive folder $DRIVE_FOLDER"
    ;;
  *)
    echo "[backup] BACKUP_GOOGLE_DRIVE_UPLOAD must be true or false" >&2
    exit 1
    ;;
esac

# Prune local copies beyond KEEP_LOCAL (newest first by name = by timestamp).
ls -1 "$BACKUP_DIR"/higherpays-*.dump 2>/dev/null | sort -r | tail -n +"$((KEEP_LOCAL + 1))" | while read -r old; do
  rm -f "$old"
  rm -f "${old%.dump}.manifest.json"
  echo "[backup] pruned $old"
done
