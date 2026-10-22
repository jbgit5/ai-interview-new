#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.local-db.yml"
CONTAINER_NAME="ai-interview-local-postgres"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker is not installed or not in PATH."
  exit 1
fi

echo "Starting local Postgres..."
docker compose -f "$COMPOSE_FILE" up -d

echo "Waiting for Postgres to become healthy..."
for i in $(seq 1 60); do
  health=$(docker inspect --format='{{json .State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo '"starting"')
  if [[ "$health" == '"healthy"' ]]; then
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "Error: Postgres container did not become healthy in time."
    docker compose -f "$COMPOSE_FILE" logs --tail=50 postgres || true
    exit 1
  fi
  sleep 2
done

echo "Resetting local database (drop + recreate ai_interview)..."
# The docker volume persists across runs, so tables may already exist.
# We reset the database so migrations can be applied from a clean slate.
docker exec -i "$CONTAINER_NAME" psql \
  -U postgres \
  -d postgres \
  -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = 'ai_interview'
   AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ai_interview;
CREATE DATABASE ai_interview;
SQL

echo "Applying migrations (local-safe subset)..."
# Note: We skip optional migrations on vanilla Postgres:
# - 002_rls_policies.sql (RLS policies — optional for local dev)
# - 003_storage.sql      (storage bucket metadata — recordings use local filesystem)
#
# These are safe on a plain local Postgres container:
for file in \
  "db/migrations/000_better_auth.sql" \
  "db/migrations/001_core_tables.sql" \
  "db/migrations/004_exit_type.sql" \
  "db/migrations/005_question_modes.sql" \
  "db/migrations/006_resume_mode.sql" \
  "db/migrations/007_company_intro.sql" \
  "db/migrations/008_turn_metrics.sql" \
  "db/migrations/008_recruiter_company_intro.sql" \
  "db/migrations/009_proctor_event_types.sql" \
  "db/migrations/010_telemetry.sql" \
  "db/migrations/011_interviewer_avatar.sql" \
  "db/migrations/012_allow_probes.sql"
do
  echo "- Running $file"
  docker exec -i "$CONTAINER_NAME" psql \
    -U postgres \
    -d ai_interview \
    -v ON_ERROR_STOP=1 < "$file"
done

echo "Applying better-auth schema compatibility fix..."
docker exec -i "$CONTAINER_NAME" psql \
  -U postgres \
  -d ai_interview \
  -v ON_ERROR_STOP=1 < "scripts/fix-better-auth-columns.sql"

echo "Ensuring local recordings directory exists..."
mkdir -p recordings
touch recordings/.gitkeep

echo "Local database is ready at: postgresql://postgres:postgres@127.0.0.1:54322/ai_interview"
echo "Interview recordings will be saved to: $(pwd)/recordings/"
