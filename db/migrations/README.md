# Database migrations (PostgreSQL)

SQL migrations for **any** Postgres instance (local Docker, cloud RDS, etc.).  
The application connects with `DATABASE_URL` via the `pg` driver (`src/lib/db.ts`).

## How to run

### Local Docker (recommended for development)

```bash
npm run db:local:setup    # fresh DB + migrations
# or incremental:
npm run db:local:migrate  # bash ./migrate-local.sh
```

### Manual (psql)

With `DATABASE_URL` in your environment:

```bash
psql "$DATABASE_URL" -f db/migrations/000_better_auth.sql
# ... repeat in numeric order for each new file
```

Or paste a migration file into **pgAdmin**, **DBeaver**, or any SQL client connected to your database.

## Migration order

Run numbered files in order (`000`, `001`, …).  
Initial setup often uses `000` → `001`, then feature migrations `004`+ as listed in `setup-local-db.sh` / `migrate-local.sh`.

- **`002_rls_policies.sql`** — optional Row Level Security (not required for local dev).
- **`003_storage.sql`** — optional storage bucket metadata (recordings in this app default to the local `recordings/` folder).

## Verification

After migrations, you should see application tables (`recruiters`, `jobs`, `interview_sessions`, …) in your database.

## Adding a new migration (the workflow)

When you (or the AI) add a new column, table, index, etc. — do **every** step below. Skipping any one of them is how schema drift and "column does not exist" 500s happen.

### 1. Create the SQL file

- File name: `db/migrations/NNN_short_description.sql` where `NNN` is the next number after the highest existing one (e.g. `013_…`, `014_…`).
- Use `IF NOT EXISTS` / `IF EXISTS` so the file can be re-run safely.
- For new columns on existing tables, prefer `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT <safe_default>` — that way existing rows get a value and the deployment is non-blocking.

Example:

```sql
-- ============================================================
-- MIGRATION 013: <what this changes and why>
-- ============================================================
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS my_new_flag BOOLEAN NOT NULL DEFAULT FALSE;
```

### 2. Add the file to both runner scripts

The scripts list migrations explicitly so they can be applied in order. Append your new file to:

- `migrate-local.sh` (incremental — preserves existing data; used by `npm run db:local:migrate`)
- `setup-local-db.sh` (full reset — drops and recreates the DB; used by `npm run db:local:setup`)

Add a trailing `\` to the previous line and put your new file on the last line of the `for file in …` list.

### 3. Apply it to your local DB

Pick one:

```bash
npm run db:local:migrate              # safest — keeps your data
# or, if you want a clean slate (DROPS the DB):
npm run db:local:setup
```

On Windows PowerShell, if `bash` is not available, you can run the new migration directly against the Docker container:

```powershell
Get-Content db/migrations/013_my_change.sql -Raw `
  | docker exec -i ai-interview-local-postgres psql -U postgres -d ai_interview -v ON_ERROR_STOP=1
```

### 4. Verify the schema change landed

```powershell
docker exec -i ai-interview-local-postgres psql -U postgres -d ai_interview -c "\d jobs"
```

You should see the new column / table.

### 5. Update the application code

- TypeScript types / Zod schemas
- API routes that `SELECT j.*` will pick the column up automatically, but **explicit `SELECT` lists** (e.g. `SELECT id, title, status …`) must be updated to include the new column.
- `INSERT` / `UPDATE` statements need the new column name + parameter.
- UI components that display or edit the field.

### 6. Restart the dev server

Next.js dev server caches compiled API routes; restart it (`Ctrl+C` then `npm run dev`) after schema changes to be safe. A hot-reload usually works for new columns added with `SELECT *`, but is unreliable for routes you rewrote.

### Production / cloud DBs

The local scripts target Docker. For Supabase / RDS / any cloud Postgres, run the same SQL file with `psql` against your `DATABASE_URL`, or paste it into pgAdmin / DBeaver / Supabase SQL editor:

```bash
psql "$DATABASE_URL" -f db/migrations/013_my_change.sql
```

