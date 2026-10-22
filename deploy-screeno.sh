#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/home/ubuntu/apps/ai-video-interview"
INCOMING_DIR="/home/ubuntu/apps/deploy-incoming"
BACKUP_DIR="/home/ubuntu/apps/backups"
BACKUP_FILE="$BACKUP_DIR/screeno-last-good.tar.gz"
LOCK_FILE="/home/ubuntu/apps/.screeno-deploy.lock"

mkdir -p "$INCOMING_DIR" "$BACKUP_DIR"
chmod 700 "$INCOMING_DIR" "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another Screeno deployment is in progress. Exiting without changes." >&2
  exit 1
fi

health_local() {
  local attempt
  for attempt in $(seq 1 20); do
    if curl --silent --show-error --fail --max-time 4 --output /dev/null http://127.0.0.1:3000/; then
      return 0
    fi
    sleep 3
  done
  return 1
}

restart_app() {
  cd "$APP_DIR"
  pm2 startOrReload ecosystem.config.cjs --only screeno --update-env
}

restore_backup() {
  if [[ ! -s "$BACKUP_FILE" ]]; then
    echo "ERROR: No valid previous-production backup exists at $BACKUP_FILE" >&2
    return 1
  fi
  if ! tar -tzf "$BACKUP_FILE" >/dev/null; then
    echo "ERROR: The previous-production backup archive is invalid." >&2
    return 1
  fi

  echo "Restoring previous production build from $BACKUP_FILE..."
  pm2 stop screeno >/dev/null 2>&1 || true
  rm -rf "$APP_DIR/.next" "$APP_DIR/public"
  rm -f "$APP_DIR/next.config.mjs"
  if ! tar -xzf "$BACKUP_FILE" -C "$APP_DIR"; then
    echo "ERROR: Could not extract the previous-production backup." >&2
    return 1
  fi
  chown -R ubuntu:ubuntu "$APP_DIR/.next" "$APP_DIR/public" "$APP_DIR/next.config.mjs"
  if ! restart_app; then
    echo "ERROR: Previous files were restored, but PM2 could not start the app." >&2
    return 1
  fi
  if ! health_local; then
    echo "ERROR: Previous files were restored, but the local health check still fails." >&2
    return 1
  fi
  echo "Rollback completed; previous version is responding locally."
}

if [[ "${1:-}" == "--rollback" ]]; then
  restore_backup
  exit $?
fi

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <uploaded-zip> <expected-zip-sha256> <expected-package-json-sha256> <expected-lockfile-sha256>" >&2
  exit 2
fi

ZIP_PATH="$1"
EXPECTED_ZIP_HASH="$2"
EXPECTED_PACKAGE_HASH="$3"
EXPECTED_LOCK_HASH="$4"
STAGE=""
NEW_BACKUP=""
DEPLOY_STARTED=0

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if [[ $rc -ne 0 && $DEPLOY_STARTED -eq 1 ]]; then
    echo "Deployment failed after production changes began. Attempting automatic rollback..." >&2
    if ! restore_backup; then
      echo "CRITICAL: Automatic rollback did not pass its checks. Inspect the server and PM2 logs immediately." >&2
    fi
  fi
  [[ -n "$STAGE" ]] && rm -rf "$STAGE"
  [[ -n "$NEW_BACKUP" && -f "$NEW_BACKUP" ]] && rm -f "$NEW_BACKUP"
  [[ -n "$ZIP_PATH" && -f "$ZIP_PATH" ]] && rm -f "$ZIP_PATH"
  exit "$rc"
}
trap on_exit EXIT

[[ -f "$ZIP_PATH" ]] || { echo "Uploaded ZIP not found: $ZIP_PATH" >&2; exit 1; }
[[ -d "$APP_DIR/.next" && -f "$APP_DIR/.next/BUILD_ID" ]] || { echo "Current production .next build is missing; refusing automated deployment." >&2; exit 1; }
[[ -d "$APP_DIR/public" && -f "$APP_DIR/next.config.mjs" ]] || { echo "Expected current public/ and next.config.mjs are required for backup." >&2; exit 1; }
[[ -f "$APP_DIR/package.json" && -f "$APP_DIR/package-lock.json" ]] || { echo "Production package.json/package-lock.json not found." >&2; exit 1; }

ACTUAL_ZIP_HASH="$(sha256sum "$ZIP_PATH" | awk '{print $1}')"
[[ "$ACTUAL_ZIP_HASH" == "$EXPECTED_ZIP_HASH" ]] || { echo "ZIP checksum mismatch; refusing deployment." >&2; exit 1; }
ACTUAL_PACKAGE_HASH="$(sed 's/\r$//' "$APP_DIR/package.json" | sha256sum | awk '{print $1}')"
ACTUAL_LOCK_HASH="$(sed 's/\r$//' "$APP_DIR/package-lock.json" | sha256sum | awk '{print $1}')"
[[ "$ACTUAL_PACKAGE_HASH" == "$EXPECTED_PACKAGE_HASH" ]] || { echo "package.json changed locally. This routine deployment intentionally does not update server dependencies; deploy stopped before production changes." >&2; exit 1; }
[[ "$ACTUAL_LOCK_HASH" == "$EXPECTED_LOCK_HASH" ]] || { echo "package-lock.json changed locally. This routine deployment intentionally does not update server dependencies; deploy stopped before production changes." >&2; exit 1; }

command -v unzip >/dev/null || { echo "unzip is required on the EC2 server." >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required on the EC2 server." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required on the EC2 server." >&2; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 is required for deployment." >&2; exit 1; }

while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  case "$entry" in
    /*|../*|*/../*|*/..) echo "Unsafe archive entry detected: $entry" >&2; exit 1 ;;
    .next|.next/|.next/*|public|public/|public/*|next.config.mjs) ;;
    *) echo "Unexpected file in deployment ZIP: $entry" >&2; exit 1 ;;
  esac
done < <(unzip -Z1 "$ZIP_PATH")

STAGE="$(mktemp -d "$INCOMING_DIR/extract.XXXXXX")"
unzip -q "$ZIP_PATH" -d "$STAGE"
[[ -f "$STAGE/.next/BUILD_ID" ]] || { echo "ZIP does not contain .next/BUILD_ID." >&2; exit 1; }
[[ -d "$STAGE/public" && -f "$STAGE/next.config.mjs" ]] || { echo "ZIP is missing public/ or next.config.mjs." >&2; exit 1; }
if find "$STAGE" -name '.env*' -o -name 'node_modules' | grep -q .; then
  echo "Deployment package must not contain .env files or node_modules." >&2
  exit 1
fi

# Build a complete temporary backup first. The existing single backup is only
# replaced after the new archive passes verification.
NEW_BACKUP="$(mktemp "$BACKUP_DIR/.screeno-last-good.XXXXXX.tar.gz")"
tar -czf "$NEW_BACKUP" -C "$APP_DIR" .next public next.config.mjs
tar -tzf "$NEW_BACKUP" >/dev/null
tar -tzf "$NEW_BACKUP" | grep -Eq '(^|/)\.next/BUILD_ID$' || { echo "Backup verification failed: BUILD_ID missing." >&2; exit 1; }
mv -f "$NEW_BACKUP" "$BACKUP_FILE"
NEW_BACKUP=""
echo "Previous production build saved in the single backup: $BACKUP_FILE"

DEPLOY_STARTED=1
pm2 stop screeno >/dev/null 2>&1 || true
rm -rf "$APP_DIR/.next" "$APP_DIR/public"
rm -f "$APP_DIR/next.config.mjs"
mv "$STAGE/.next" "$APP_DIR/.next"
mv "$STAGE/public" "$APP_DIR/public"
mv "$STAGE/next.config.mjs" "$APP_DIR/next.config.mjs"
chown -R ubuntu:ubuntu "$APP_DIR/.next" "$APP_DIR/public" "$APP_DIR/next.config.mjs"
restart_app

if ! health_local; then
  echo "Local Next.js health check failed on http://127.0.0.1:3000/." >&2
  exit 1
fi

DEPLOY_STARTED=0
echo "Deployment succeeded. Local health check passed. Build ID: $(cat "$APP_DIR/.next/BUILD_ID")"
