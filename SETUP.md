# Phase 1 Complete — Setup Guide

Phase 1 (Foundation) is fully implemented. Follow these steps to get the app running.

---

## Local Database Quick Start

The app uses **PostgreSQL** via Docker (or any Postgres you point `DATABASE_URL` at). There is **no Supabase** service in this project—only SQL migration files and the `pg` driver.

1. Start local DB and run required migrations:
   ```bash
   cd ai-interview-platform
   npm run db:local:setup
   ```
2. Start the app:
   ```bash
   npm run dev
   ```
3. Open http://localhost:3000 and test sign-up/sign-in.

Set **`DATABASE_URL`** in `.env.local` (see `.env.example`). Local Docker defaults to:
- `postgresql://postgres:postgres@127.0.0.1:54322/ai_interview?sslmode=disable`

Useful commands:
- `npm run db:local:up` → start DB only
- `npm run db:local:down` → stop DB
- `npm run db:local:fix-auth-schema` → repair better-auth table columns on existing local DB

---

## What Was Built

✅ **Authentication**: better-auth with email/password sign-in/sign-up  
✅ **Database**: PostgreSQL schema applied from `db/migrations/`  
✅ **Dashboard Shell**: Protected recruiter dashboard with sidebar navigation  
✅ **Environment**: All configs and types set up  
✅ **Build Verified**: Next.js app compiles successfully  

---

## Database migrations

**Automated (local Docker):** `npm run db:local:setup` applies the standard migration set (see `setup-local-db.sh`).  
**Incremental:** `npm run db:local:migrate` runs newer SQL files from `db/migrations/`.

**Manual:** Use `psql`, pgAdmin, or any SQL client with your `DATABASE_URL`. Order matters—see [db/migrations/README.md](./db/migrations/README.md).

Core files:

1. **`db/migrations/000_better_auth.sql`** — better-auth tables  
2. **`db/migrations/001_core_tables.sql`** — application tables  
3. **`002_rls_policies.sql` / `003_storage.sql`** — optional (RLS, storage metadata); skipped by default on plain local Postgres.

### Verify tables

After migrations you should have `user`, `session`, `recruiters`, `jobs`, `interview_sessions`, etc. (inspect with `psql \dt` or your GUI).

---

## Running the App

### Development server

```bash
cd ai-interview-platform
npm run dev
```

Open http://localhost:3000 → should redirect to `/sign-in`.

### Test the auth flow

1. **Sign up**: Navigate to http://localhost:3000/sign-up
   - Enter name, email, password
   - Click "Create account"
   - Should redirect to `/dashboard` on success

2. **Verify recruiter row**: In Postgres, query `recruiters` (e.g. `SELECT * FROM recruiters;`)
   - A new row should appear with your email and `better_auth_user_id` populated

3. **Dashboard**: After sign-in, you should see:
   - Sidebar with "Dashboard", "Jobs", "Candidates" links
   - Welcome message with your name
   - Stat cards showing `—` (no data yet)
   - "Create your first job" CTA

4. **Sign out**: Click "Sign out" in sidebar → redirects to `/sign-in`

5. **Sign in**: Use the same credentials → should sign in successfully

---

## Troubleshooting

### Build errors

If you see TypeScript errors, make sure all packages installed:
```bash
npm install
```

### "Could not connect to database" error

Check `.env.local` has a valid **`DATABASE_URL`** for your Postgres (local Docker URL is in `.env.example`).  
Ensure the database is running (`npm run db:local:up` for Docker).

### "password authentication failed" (Postgres code `28P01`)

Wrong user/password or database name in `DATABASE_URL`. For local Docker, defaults are user `postgres`, password `postgres`, database `ai_interview`. Restart `npm run dev` after changing `.env.local`.

### better-auth session errors

1. Make sure migrations were run (better-auth needs `user`, `session` tables)
2. Check `BETTER_AUTH_SECRET` is set in `.env.local`
3. Try signing up with a new test account

### Middleware redirect loop

If you get infinite redirects:
- Make sure better-auth migrations were run
- Check browser console for errors
- Clear cookies and try again

---

## What's Next: Phase 2

Phase 1 is complete. The foundation is ready.

**Phase 2 will add**:
- Jobs CRUD (create, edit, list, delete)
- Question bank builder
- AI-generated questions from job description (GPT-4o)
- Scoring rubric builder
- Candidate invite system (with Resend email)

To proceed with Phase 2, you'll need:
- **OpenAI API key** (for GPT-4o question generation)
- **Resend API key** (for sending invite emails)

See [docs/08-build-phases.md](./docs/08-build-phases.md) for Phase 2 details.

---

## Testing Checklist

Before moving to Phase 2, verify:

- [ ] Database migrations ran successfully (tables visible in Postgres)
- [ ] App builds without errors (`npm run build`)
- [ ] Sign-up flow works (new recruiter row appears in DB)
- [ ] Sign-in flow works (redirects to dashboard)
- [ ] Dashboard loads with sidebar and stats
- [ ] Sign-out works (redirects to sign-in)
- [ ] Middleware protection works (accessing `/dashboard` when signed out redirects to `/sign-in`)

---

## File Structure

```
ai-interview-platform/
├── .env.local                          ✅ Your credentials (NOT committed)
├── .env.example                        ✅ Template
├── middleware.ts                       ✅ Auth protection
├── db/migrations/                      ✅ PostgreSQL schema (SQL files)
│   ├── README.md
│   ├── 000_better_auth.sql
│   ├── 001_core_tables.sql
│   └── …
├── src/
│   ├── app/
│   │   ├── api/auth/[...all]/route.ts  ✅ better-auth handler
│   │   ├── dashboard/
│   │   │   ├── layout.tsx              ✅ Protected layout
│   │   │   └── page.tsx                ✅ Dashboard home
│   │   ├── sign-in/page.tsx            ✅ Sign-in form
│   │   ├── sign-up/page.tsx            ✅ Sign-up form
│   │   ├── layout.tsx                  ✅ Root layout
│   │   └── page.tsx                    ✅ Redirects to sign-in
│   ├── components/
│   │   └── dashboard/Sidebar.tsx       ✅ Nav sidebar
│   ├── lib/
│   │   ├── auth.ts                     ✅ better-auth config
│   │   ├── auth-client.ts              ✅ Client-side auth
│   │   └── db.ts                       ✅ PostgreSQL pool (`DATABASE_URL`)
│   └── types/index.ts                  ✅ TypeScript types
└── package.json                        ✅ All deps installed
```

---

**Phase 1 Status: ✅ COMPLETE**

Ready to proceed to Phase 2 when you are!
