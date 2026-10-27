#!/usr/bin/env bash
# Deploy from your laptop to EC2 (build locally, rsync, restart PM2).
#
# First-time setup (on laptop):
#   cp scripts/deploy-prod.env.example scripts/deploy-prod.env
#   nano scripts/deploy-prod.env
#
# Usage:
#   npm run deploy:prod
#   npm run deploy:prod -- --deps    # also upload node_modules (after package.json changes)
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT_DIR/scripts/deploy-prod.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST in scripts/deploy-prod.env}"
USER="${DEPLOY_USER:-ubuntu}"
KEY="${DEPLOY_KEY:-$HOME/Downloads/screeno-key.pem}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/ubuntu/apps/ai-video-interview}"
PM2_NAME="${DEPLOY_PM2_NAME:-screeno}"

INCLUDE_DEPS=0
for arg in "$@"; do
  if [[ "$arg" == "--deps" ]]; then
    INCLUDE_DEPS=1
  fi
done

if [[ ! -f "$KEY" ]]; then
  echo "Error: SSH key not found: $KEY"
  echo "Set DEPLOY_KEY in scripts/deploy-prod.env"
  exit 1
fi

SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new)
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

echo "==> Building Next.js (uses .env.production only — .env.local is ignored for this build)..."
# .env.local overrides .env.production during `next build`; hide it so prod URLs are baked in.
ENV_LOCAL_BACKUP=""
if [[ -f .env.local ]]; then
  ENV_LOCAL_BACKUP=".env.local.deploy-bak"
  mv .env.local "$ENV_LOCAL_BACKUP"
fi
npm run build
if [[ -n "$ENV_LOCAL_BACKUP" && -f "$ENV_LOCAL_BACKUP" ]]; then
  mv "$ENV_LOCAL_BACKUP" .env.local
fi

RSYNC_EXCLUDES=(
  --exclude .git
  --exclude .env.local
  --exclude .env.development
  --exclude recordings
  --exclude cv-uploads
  --exclude .cursor
)

if [[ "$INCLUDE_DEPS" -eq 0 ]]; then
  RSYNC_EXCLUDES+=(--exclude node_modules)
  echo "==> Syncing code + .next (no node_modules; use --deps if package.json changed)..."
else
  echo "==> Installing dependencies locally..."
  npm ci
  echo "==> Syncing code + .next + node_modules..."
fi

# Do not overwrite server-only secrets by default
RSYNC_EXCLUDES+=(--exclude .env.production)

# No --delete: keeps server recordings/ and .env.production safe
rsync -avz "${RSYNC_EXCLUDES[@]}" \
  -e "$RSYNC_SSH" \
  "$ROOT_DIR/" \
  "${USER}@${HOST}:${REMOTE_DIR}/"

if [[ "$INCLUDE_DEPS" -eq 0 ]]; then
  echo "==> Remote: install deps only if package-lock changed..."
  ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" bash -s <<REMOTE
set -euo pipefail
cd "${REMOTE_DIR}"
if [[ ! -x node_modules/.bin/next ]]; then
  echo "node_modules missing — running npm ci on server (may take a while)..."
  npm ci --omit=dev
fi
REMOTE
fi

echo "==> Restarting PM2 (ecosystem loads .env.production)..."
ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" bash -s <<REMOTE
set -euo pipefail
cd "${REMOTE_DIR}"

# .env.local on the server overrides .env.production and causes INVALID_ORIGIN
if [[ -f .env.local ]]; then
  echo "WARNING: Removing server .env.local (it overrides prod URLs)."
  rm -f .env.local
fi

echo "Server auth URLs:"
grep -E '^BETTER_AUTH_URL=|^NEXT_PUBLIC_APP_URL=' .env.production || true

pm2 delete ${PM2_NAME} 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
curl -sf -o /dev/null -I http://127.0.0.1:3000 && echo "App responded on :3000"
REMOTE

echo ""
echo "Done. Open: http://${HOST}"
