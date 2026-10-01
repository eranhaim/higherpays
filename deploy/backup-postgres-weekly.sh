#!/bin/sh
# Weekly backup entry point for systemd. Its optional Drive settings are kept
# outside the repository in a root-owned file.
set -eu

CONFIG="${BACKUP_DRIVE_CONFIG:-/etc/higherpays/backup-drive.env}"

if [ -r "$CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
else
  export BACKUP_GOOGLE_DRIVE_UPLOAD=false
  echo "[backup] Google Drive configuration is absent; running local backup only"
fi

if [ -n "${BACKUP_KEEP_LOCAL:-}" ]; then
  export KEEP_LOCAL="$BACKUP_KEEP_LOCAL"
fi

exec /bin/sh deploy/backup-postgres.sh
