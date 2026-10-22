#!/usr/bin/env bash
# Run only the ALTER/CREATE migrations that are safe to apply on top of an existing DB.
# Does NOT reset the database — your data is preserved.
# Use this when you add a new migration and don't want to drop everything.

set -euo pipefail
CONTAINER="ai-interview-local-postgres"

echo "Applying incremental migrations to existing local DB..."

for file in \
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
  echo "- $file"
  docker exec -i "$CONTAINER" psql \
    -U postgres \
    -d ai_interview \
    -v ON_ERROR_STOP=0 < "$file" 2>&1 | grep -v "^$" || true
done

echo "Done. All migrations applied (errors for already-existing columns are safe to ignore)."
