# CLAUDE.md

Screeno is an AI video-interview platform. Recruiters create jobs and invite candidates. An AI interviewer, "Maya", runs a spoken, adaptive interview in the browser, and recruiters then review a scored report with video, transcript and proctoring results.

Full diagrams, the service map and the config reference are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read it before making structural changes.

## Stack

- Next.js 14 App Router + TypeScript + Tailwind, all in one app (UI and `/api` route handlers)
- PostgreSQL via raw `pg` Pool (`src/lib/db.ts`). There is no ORM. Always use parameterised queries (`$1`).
- better-auth for recruiter login (`src/lib/auth.ts`). `middleware.ts` guards `/dashboard/*`.
- External services:
  - **OpenAI** (gpt-4o brain/summary, gpt-4o-mini scoring/question-gen, tts-1 `nova` voice)
  - **Deepgram Nova-3** (live STT, browser WS with a server-minted temp token; Web Speech API fallback)
  - **LiveKit Cloud** (WebRTC)
  - **Resend** (invite email)

## Commands

```bash
npm run dev                 # frees port 3000, then next dev -p 3000
npm run build && npm start
npm run lint
npm test                    # regression suites (pipeline, live, proctor, screening) — no API cost
npm run db:local:up         # Docker Postgres on 127.0.0.1:54322 (db ai_interview)
npm run db:local:setup      # RESET + apply all migrations (destroys local data)
npm run db:local:migrate    # apply new migrations only
npm run deploy:prod         # bash/rsync deploy to EC2 (add -- --deps if package.json changed)
./deploy.ps1                # Windows zip deploy → deploy-screeno.sh (backup + health check + auto-rollback)
```

## Where things live

- `src/app/interview/[token]/{page,check,room}`: candidate flow (token in URL is the only credential)
- `src/app/dashboard/**`: recruiter UI (jobs, questions, invites, reports, observability, voice-test lab)
- `src/app/api/sessions/[token]/turn/route.ts`: **core interview brain**. gpt-4o decides `next | probe | close` in parallel with gpt-4o-mini scoring. `MAX_TURNS = 10`.
- `src/app/api/sessions/[token]/end/route.ts`: final gpt-4o summary → `analysis_results`
- `src/lib/prompts.ts`: all LLM prompts. `src/lib/weakAnswerSignals.ts`: probe heuristics.
- `src/hooks/useInterview.ts`: client state machine `idle → intro → speaking ⇄ listening ⇄ processing → completed`
- `src/hooks/useSpeechCapture.ts`: Deepgram STT, end-of-turn logic, Web Speech fallback
- `src/hooks/useAudioPlayer.ts`: TTS playback (MediaSource streaming)
- `src/hooks/useVideoRecorder.ts`: 5s webm chunks → `recordings/<sessionId>/` on local disk
- `src/hooks/useProctor.ts`: integrity events → `/api/sessions/[token]/proctor`
- `src/lib/telemetry/*`, `src/lib/observability/*`: latency/vendor telemetry and dashboards
- `db/migrations/`: the authoritative schema, applied in numeric order. `supabase/migrations/` is legacy.

## Experiment: GPT-Live voice (branch `experiment/gpt-live`)

Optional replacement for the Deepgram + TTS voice path, **off by default**. `useLiveInterview` mirrors `useInterview`'s return shape; `/turn` stays the brain; `useProctor` and the recorder are engine-independent. Spend is capped by a server-side ledger (`live_voice_sessions`, `src/lib/live/guardrails.ts`) and requires a dedicated `OPENAI_LIVE_API_KEY`. Read [docs/GPT-LIVE-EXPERIMENT.md](docs/GPT-LIVE-EXPERIMENT.md) before touching it. Never run live sessions without the caps set. Track results with `scripts/live-metrics.sql` (live vs legacy wait, outcomes, spend). To see what went wrong in ONE interview use Dashboard → Diagnostics (`src/lib/diagnostics/diagnoseSession.ts` holds the rules, `src/app/dashboard/diagnostics/*` the pages). Add a rule there whenever a new failure mode is found. **Run `npm run test:live` after touching `useLiveInterview.ts`, `src/lib/live/*` or `diagnoseSession.ts`** — it replays real failures (turn-taking, invented questions, missing goodbye) as regression tests; add a case for each new real failure (details in §4e of the experiment doc). Optional real-person lip-sync avatar ("Maya (real)", Simli): see §4d of the experiment doc — spend is capped by `avatar_sessions` + Simli's own `maxSessionLength`, and any failure falls back to the still photo while GPT-Live audio keeps playing.

## CV screening (Phase 2)

Job → CV Screening tab: versioned criteria, bulk PDF/DOCX upload, in-process DB-backed queue (`src/lib/screening/worker.ts`, `cv_screenings` is the queue), evidence report with original CV, HR corrections, decisions, shortlist → invite. Read [docs/CV-SCREENING.md](docs/CV-SCREENING.md) before touching it.
- The LLM only transcribes and classifies; **all arithmetic and scoring is deterministic** (`timeline.ts`, `scoring.ts`). Never ask the model for scores or durations.
- CV text is untrusted: keep it fenced (`neutralizeUntrusted`), keep schemas strict, keep citation verification. Contacts are masked before any OpenAI call.
- Every route under `api/jobs/[id]/screening` must call `requireRecruiterJob()` and filter child rows by `job_id` (a test enforces this). Never log CV text.
- Changing a screening prompt → bump `SCREENING_PROMPT_VERSION`; changing the rubric → bump `RUBRIC_VERSION`.
- Run `npm run test:screening` after touching `src/lib/screening/*`; `npm run test:screening:db` (local Docker DB only) after touching SQL/worker.

## Interview room, debug mode, proctoring

- The room (`src/app/interview/[token]/room/page.tsx`) is Meet-style: Maya tile + candidate tile, captions, control bar. Developer panels (logs, engine, transcript, integrity) render **only** when the recruiter enables Dashboard → Settings → Debug mode (`recruiters.debug_mode`, migration 016, returned by `/start`).
- Proctoring: see [docs/PROCTORING.md](docs/PROCTORING.md). Rules + the single penalty table live in `src/lib/proctor/rules.ts` (pure, tested). AI detection is `useAiProctor` (MediaPipe, in-browser, fail-open). The integrity score is computed server-side in `/end` — never trust a client value.
- Run `npm test` (= `test:live` + `test:proctor`) after touching the room, the live engine or proctoring.

## Conventions and gotchas

- **The code is the source of truth over the docs.** `docs/PROJECT-OVERVIEW.md` still describes AssemblyAI as the live STT provider, but AssemblyAI is only used in the Voice Lab (`/dashboard/voice-test`).
- Third-party API keys stay server-side. The browser only gets short-lived tokens (`/api/deepgram/token`, `/api/livekit/token`).
- Recruiter API routes must verify `auth.api.getSession()` and scope queries through `recruiters.better_auth_user_id`.
- Candidate routes are keyed by `interview_sessions.token` (UUID). Never expose the numeric `id`. Completed sessions return 409 and expired ones return 410.
- Before deleting questions, set `transcript_turns.question_id` and `question_scores.question_id` to NULL in code. The FK has no ON DELETE rule, so the delete fails otherwise. See `api/jobs/[id]/questions/[qid]` and `regenerate`. Never delete transcript history.
- New proctoring event types need a DB constraint migration (see `009_proctor_event_types.sql`).
- New schema changes go in a new numbered file in `db/migrations/`. Don't edit applied migrations.
- `audio.play()` must be unlocked synchronously in the click handler (`unlockAudio()`) before any `await`, or the browser autoplay policy will block it.
- `.env.local` sets the app URL to `http://localhost:9095`, but `npm run dev` serves on port 3000. Keep `BETTER_AUTH_URL`/`NEXT_PUBLIC_APP_URL` matched to the port you actually run on, or auth will break.

## Environments and secrets

- `.env.local` (dev) and `.env.production` (prod build + PM2 runtime) are git-ignored. **Never commit them**, because GitHub push protection will block the push. See `docs/ARCHITECTURE.md` §5 for every variable and which ones are actually read.
- Prod runs on a single AWS EC2 (Ubuntu) box: PM2 app `screeno` on :3000 behind HTTPS at `https://screeno-ai.duckdns.org`. Postgres and `recordings/` are on the same host.
- Deploys never overwrite the server's `.env.production`.
