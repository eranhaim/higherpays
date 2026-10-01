# Weekly Google Drive backups

`higherpays-backup-weekly.timer` runs every Sunday at 03:15 UTC. It is
persistent, so systemd runs a missed backup shortly after the VPS starts.
The service writes custom-format dumps and JSON manifests to
`/var/backups/higherpays`, owned by root with mode `0700`, and keeps 30 dumps.

The weekly service is safe to enable before Google Drive is configured. Without
`/etc/higherpays/backup-drive.env`, it creates a local backup and exits
successfully without attempting an upload.

## One-time Google Drive setup

Use a Google **service account** JSON key, not an OAuth `client_secret_*.json`
file. Store it at the path configured in the root-only backup config:

```sh
install -d -m 700 /etc/higherpays
install -o root -g root -m 600 /path/to/service-account.json \
  /etc/higherpays/google-drive-service-account.json
install -o root -g root -m 600 deploy/backup-drive.env.example \
  /etc/higherpays/backup-drive.env
# Set BACKUP_GOOGLE_DRIVE_FOLDER_ID to the folder ID supplied by the customer.
. /etc/higherpays/backup-drive.env
```

In Google Drive, share the customer-provided destination folder with the
service account's `client_email` as **Editor**. Set its folder ID only in
`/etc/higherpays/backup-drive.env`; do not put the Drive URL or ID in git.

Install rclone and create its root-only configuration:

```sh
apt-get update
apt-get install -y rclone
install -d -m 700 /root/.config/rclone
rclone config create higherpays-drive drive \
  scope drive \
  service_account_file /etc/higherpays/google-drive-service-account.json \
  root_folder_id "$BACKUP_GOOGLE_DRIVE_FOLDER_ID"
CRYPT_PASSWORD="$(rclone obscure "$(openssl rand -base64 48)")"
CRYPT_SALT="$(rclone obscure "$(openssl rand -base64 48)")"
rclone config create higherpays-drive-crypt crypt \
  remote higherpays-drive: \
  filename_encryption off \
  directory_name_encryption false \
  password "$CRYPT_PASSWORD" \
  password2 "$CRYPT_SALT"
unset CRYPT_PASSWORD CRYPT_SALT
chmod 600 /root/.config/rclone/rclone.conf
```

The crypt remote encrypts file contents while retaining readable dated folders
and filenames. Do not lose `/root/.config/rclone/rclone.conf`: it contains the
encryption material needed to restore Drive backups.

Enable uploads only after this remote can list the target folder:

```sh
rclone lsd higherpays-drive-crypt:
install -o root -g root -m 600 deploy/backup-drive.env.example \
  /etc/higherpays/backup-drive.env
# Set BACKUP_GOOGLE_DRIVE_FOLDER_ID and BACKUP_GOOGLE_DRIVE_REMOTE, then
# change BACKUP_GOOGLE_DRIVE_UPLOAD=true in /etc/higherpays/backup-drive.env.
```

## Test and restore

Upload one test backup under today's dated folder without touching the live
database:

```sh
cd /home/deploy/higherpays
sudo env BACKUP_RUN_LABEL="test-run-$(date -u +%H%M%S)" \
  /bin/sh deploy/backup-postgres-weekly.sh
```

Each upload contains a `higherpays-*.dump` and a non-secret
`higherpays-*.manifest.json`. Download both through the crypt remote, verify
the manifest's SHA-256 checksum, then restore only to a non-production
database:

```sh
sha256sum higherpays-*.dump
sh deploy/restore-postgres.sh higherpays-*.dump higherpays_restore_test
```

The manifest records the UTC creation time, size, SHA-256, custom dump format,
and restore command. Never run a restore without the second,
non-production target argument unless a live replacement is explicitly
intended and confirmed.
