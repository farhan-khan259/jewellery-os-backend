#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_MONGODB_URI:?Set RESTORE_MONGODB_URI to an EMPTY isolated restore database}"
: "${RESTORE_DATABASE:?Set a NEW restore database name}"
: "${SOURCE_DATABASE:?Set the original database name}"
restore_archive="${1:?Pass the backup archive path}"
if [[ "$RESTORE_DATABASE" == "$SOURCE_DATABASE" ]]; then
  printf 'Restore into a different, empty database first.\n' >&2
  exit 1
fi
sha256sum -c "$restore_archive.sha256"
mongorestore --uri="$RESTORE_MONGODB_URI" --archive="$restore_archive" --gzip \
  --nsFrom="$SOURCE_DATABASE.*" --nsTo="$RESTORE_DATABASE.*"
printf 'Restore completed. Compare collection counts and verify a known invoice before using the restored data.\n'
