#!/bin/bash
# Print migration paths for manual runs against your DATABASE_URL (psql, GUI, etc.)

echo "==================================="
echo "Database migrations (PostgreSQL)"
echo "==================================="

if [ ! -d "db/migrations" ]; then
    echo "❌ Error: db/migrations folder not found"
    exit 1
fi

echo ""
echo "Run these in order with psql, e.g.:"
echo "  psql \"\$DATABASE_URL\" -f db/migrations/000_better_auth.sql"
echo ""
echo "First migration (better-auth tables):"
echo "---"
cat db/migrations/000_better_auth.sql
echo ""
echo "==================================="
echo ""
echo "Core tables (excerpt from 001_core_tables.sql):"
head -n 80 db/migrations/001_core_tables.sql
echo ""
echo "==================================="
echo "See db/migrations/README.md for full order and local Docker scripts."
