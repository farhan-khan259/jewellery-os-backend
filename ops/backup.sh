#!/usr/bin/env bash
set -euo pipefail
: "${MONGODB_URI:?Set MONGODB_URI}"
: "${BACKUP_DIR:?Set BACKUP_DIR to a protected backup directory}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/jeweller-os-$backup_stamp.archive.gz"
umask 077
mongodump --uri="$MONGODB_URI" --archive="$backup_file" --gzip
sha256sum "$backup_file" > "$backup_file.sha256"
# Offsite destination is configured by the deployment owner; do not delete local backups automatically.
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$backup_file" "$BACKUP_S3_URI/" --sse AES256
  aws s3 cp "$backup_file.sha256" "$BACKUP_S3_URI/" --sse AES256
fi
printf 'Backup complete: %s\n' "$backup_file"
