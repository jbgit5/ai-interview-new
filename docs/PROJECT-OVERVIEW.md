# Screeno — AI Interview Platform
### Project Architecture & Technical Reference

---

## 1. What This Project Does

**Screeno** is a fully automated AI-powered recruitment screening platform. A recruiter creates a job, and the system takes over the entire first-round interview process:

1. Recruiter creates a job and defines competencies
2. AI generates tailored interview questions from the job description
3. Recruiter sends an email invite link to the candidate
4. Candidate clicks the link, passes consent, and is interviewed by **Maya** — an AI voice interviewer
5. Maya conducts a full spoken, adaptive conversation — asking questions, probing weak answers, and knowing when to close
6. The session is recorded (video + audio), transcript is saved, and each answer is scored by AI
7. Recruiter reviews a report: AI summary, competency scores, video recording, proctoring integrity score

No human is needed in the loop until the recruiter reviews the report.

---

## 2. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Framework** | Next.js 14 (App Router) | Full-stack in one repo — API routes + React UI, server components for DB queries |
| **Language** | TypeScript | Type safety across DB types, API contracts, AI response shapes |
| **Styling** | Tailwind CSS + custom design tokens | Utility-first with consistent design system (violet accent, white cards) |
| **Database** | PostgreSQL (via `pg` pool) | Relational data fits the recruiter → job → session → turn hierarchy perfectly |
| **Auth** | better-auth | Drop-in email/password auth with database hooks — auto-creates recruiter row on sign-up |
| **Email** | Resend + React Email | Transactional invite emails with responsive HTML templates |
| **Video infra** | LiveKit (WebRTC) | Manages candidate camera/mic tracks, handles reconnection, provides clean React hooks |
| **Video recording** | MediaRecorder API | Records LiveKit tracks in 5-second chunks, uploaded to local filesystem |
| **Speech-to-Text** | AssemblyAI v3 WebSocket | Real-time PCM streaming STT — used in all live interviews |
| **Text-to-Speech** | OpenAI TTS-1 `nova` | Single-provider TTS for Maya to reduce latency variance and simplify runtime failure modes |
| **AI Brain** | OpenAI GPT-4o | Powers Maya's adaptive turn decisions and final interview summary |
| **AI Scoring** | OpenAI GPT-4o-mini | Per-answer scoring (cheaper model — runs in parallel with brain call) |
| **AI Question Gen** | OpenAI GPT-4o-mini | Generates questions from JD at job creation time and for resume mode |
| **PDF parsing** | pdf-parse | Extracts text from uploaded candidate CVs for resume-mode interviews |
| **Charts** | Recharts | Competency score radar chart in the interview report |
| **PDF export** | @react-pdf/renderer | Exports the full interview report as a downloadable PDF |

**Packages installed but not used in production code:**
- `face-api.js` — in package.json but not imported anywhere; face detection uses canvas pixel analysis instead
- `@huggingface/inference` — in package.json; was intended for Kokoro TTS but is not used in the current OpenAI TTS path
- `zustand` — in package.json; not imported anywhere; all state uses React hooks
- `zod` — in package.json; not imported anywhere; validation done inline

---

## 3. Database Schema

```
recruiters ─────────────── (one per HR user, linked to better-auth)
    │
    └── jobs ──────────────── (job postings with title, description, mode)
            │
            ├── questions ──── (interview questions — AI-generated or manual)
            ├── scoring_rubrics (competencies with weights, e.g. "Problem Solving: 30%")
            └── interview_sessions ── (one per candidate invite)
                        │
                        ├── transcript_turns ── (every spoken turn, both roles)
                        ├── question_scores ──── (AI score 1–10 per answer)
                        ├── analysis_results ─── (final summary, recommendation)
                        └── proctoring_events ── (integrity violation events)
```

**Key design decisions:**
- `interview_sessions.token` is the UUID passed in the candidate URL — never expose the numeric `id` to candidates
- `transcript_turns.question_id` is nullable — transcript history is preserved even if questions are deleted/regenerated (FK is nullified, not cascaded)
- `expires_at` defaults to 7 days; status flow: `pending → in_progress → completed`
- `integrity_score` on sessions starts at 100; each proctoring event deducts penalty points

---

## 4. Interview Question Modes

| Mode | What happens |
|---|---|
| `ai_only` | GPT-4o-mini generates 7 questions from the JD at job creation time |
| `custom_only` | Recruiter manually writes all questions — no AI generation |
| `mixed` | AI generates a base set at job creation; recruiter can edit/add more |
| `resume` | Recruiter uploads candidate's CV when sending invite; GPT-4o-mini parses the PDF and generates personalised questions at invite time |

---

## 5. The AI Interview Engine (`useInterview` hook)

This is the core of the product. It orchestrates a real-time spoken interview as a state machine:

```
idle → intro → listening ⇄ processing ⇄ speaking → completed
```

### State machine breakdown

| State | What's happening |
|---|---|
| `idle` | Waiting for candidate to click Start |
| `intro` | Fetching opening greeting from GPT-4o → playing Maya's voice via TTS |
| `listening` | AssemblyAI WebSocket active, capturing candidate's speech in real-time PCM |
| `processing` | Candidate finished speaking → calling `/api/sessions/[token]/turn` → GPT-4o decides next action |
| `speaking` | TTS audio for Maya's next question is playing |
| `completed` | GPT-4o returned `"action": "close"` → interview over |

### How Maya decides what to say next

Every candidate turn triggers **two parallel GPT calls**:
1. **GPT-4o (brain)** — decides the next interview action
2. **GPT-4o-mini (scorer)** — scores the candidate's answer against rubric competencies

The brain call receives a structured system prompt containing:
- All unasked questions with IDs, categories, difficulty
- Competencies to cover
- Current turn number and max turns
- Probe counts per question (max 2 probes before moving on)
- Uncovered categories (Maya must cover all categories before closing)

GPT-4o returns JSON:
```json
{
  "action": "probe" | "next" | "close",
  "question": "Maya's next spoken line",
  "question_id": "uuid or null",
  "notes": "internal reasoning"
}
```

This makes Maya adaptive — she digs deeper on shallow answers, skips to the next topic when satisfied, and closes naturally when coverage is complete.

### Zero-latency listen start (pre-warm pattern)

Maya's TTS plays while the AssemblyAI WebSocket is already connecting in the background (`activeRef.current = false` discards audio during TTS). The moment TTS ends, `activate()` flips the ref to `true` — no delay between Maya finishing and starting to capture the candidate's first word.

---

## 6. Real-Time Speech Capture (`useSpeechCapture` hook)

- Opens an **AssemblyAI v3 WebSocket** with PCM Int16 audio at 16kHz
- Uses `ScriptProcessorNode` (4096 samples per buffer, ~256ms per frame) to convert Float32 mic samples → Int16 binary frames sent over the WebSocket
- AssemblyAI returns `Turn` events with `end_of_turn: true` when it detects the candidate has finished speaking
- Key tuning parameters:
  - `max_turn_silence: "2500"` — 2.5s of silence before turn is considered done
  - `min_turn_silence: "1000"` — prevents accepting a pause mid-sentence as end-of-turn
  - `end_of_turn_confidence_threshold: "0.5"`
- **Short-answer protection**: if the turn has fewer than 3 words, a 3-second grace timer waits before accepting — prevents cutting off "No, I think..." type partial answers
- `keywords` array passes job-specific vocabulary (job title, tech stack) to AssemblyAI for better accuracy on domain terms

---

## 7. Text-to-Speech (`/api/speak` + `useAudioPlayer`)

**Provider: OpenAI TTS-1 `nova`**
- Single production TTS provider
- 15-second timeout
- Returns `audio/mpeg` from `/api/speak`

The audio plays via a plain `<audio>` element. The `speak()` function returns a Promise that resolves when playback ends, allowing the state machine to `await` it before starting to listen.

---

## 8. Video Recording (`useVideoRecorder` hook)

- Uses `MediaRecorder` on the LiveKit `LocalVideoTrack` + `LocalAudioTrack` streams
- Records in `video/webm; codecs=vp8,opus`
- Fires an `ondataavailable` event every **5 seconds** (`CHUNK_INTERVAL_MS = 5000`)
- Each chunk is uploaded to `/api/recordings/[sessionId]/chunk?index=N` as raw `video/webm` binary
- Chunks are stored on disk at `recordings/[sessionId]/chunk-N.webm`
- On playback (report page), chunks are concatenated and served as a single stream
- When interview completes: recording stops, LiveKit tracks are stopped, all `<video>/<audio>` `srcObject` is cleared — browser camera/mic indicator turns off immediately

---

## 9. Proctoring (`useProctor` hook)

Runs silently during the entire interview. Detection methods and status:

| Event | Detection method | Implemented? | Severity | Penalty |
|---|---|---|---|---|
| Tab switch | `visibilitychange` event | ✅ Yes | medium | -10 |
| Window blur | `blur` event | ✅ Yes | low | -5 |
| Paste detected | `paste` event | ✅ Yes | low | -5 |
| Right-click | `contextmenu` event | ✅ Yes | low | -2 |
| DevTools open | Keyboard shortcuts (F12, Ctrl+Shift+I) + window size heuristic | ✅ Yes | high | -20 |
| Fullscreen exit | `fullscreenchange` event | ✅ Yes | medium | -5 |
| No face / absent | Canvas skin-tone pixel ratio | ✅ Yes | medium | -8 |
| Phone detected | Canvas bright-pixel ratio (screen glow proxy) | ✅ Yes | high | -20 |
| Multiple faces | Type defined, penalty defined | ❌ Not yet detected | high | -15 |
| Gaze away | Type defined, penalty defined | ❌ Not yet detected | low | -3 |

**Face/phone detection** works by sampling an 80×60 canvas snapshot of the video every 5 seconds:
- **No face**: counts skin-tone pixels — if `skinRatio < 0.01` for 5 consecutive checks (25 continuous seconds), flags `no_face`
- **Phone**: counts very bright pixels (R,G,B > 220) — if `brightRatio` is between 12–35% of frame, flags `phone_detected`

Each event is POSTed to `/api/sessions/[token]/proctor` and stored in `proctoring_events`. The report page shows a grouped summary with an integrity score.

---

## 10. Recruiter Dashboard

| Page | What it does |
|---|---|
| `/dashboard` | Overview stats — total jobs, sessions this week, recent activity |
| `/dashboard/jobs` | Job card grid — create, view status, quick actions |
| `/dashboard/jobs/new` | Create job form — title, dept, description, question mode (colored 2×2 card grid) |
| `/dashboard/jobs/[id]/questions` | View/edit AI-generated questions, add custom ones, regenerate AI set |
| `/dashboard/jobs/[id]/invite` | Send invite emails (with optional CV upload for resume mode), see all candidates with status |
| `/dashboard/jobs/[id]/edit` | Edit title, description, status |
| `/dashboard/candidates` | Cross-job candidate table |
| `/dashboard/reports/[sessionId]` | Full interview report |
| `/dashboard/avatar` | Select Maya's avatar |
| `/dashboard/voice-test` | Voice Lab — test and compare AssemblyAI, Deepgram nova-3, Gladia Solaria-1, and Web Speech API |

---

## 11. Interview Report Page

Split into a 2-column layout (`lg:grid-cols-3`):

**Left column (2/3):**
- AI-generated summary paragraph
- Strengths and Concerns
- Per-question score cards (score 1–10, reasoning, competency breakdown)
- Full transcript (interviewer + candidate turns)

**Right column (1/3):**
- Video recording player (dark theme, 190px height, lazy-loads on play)
- Competency scores (Recharts radar chart)
- Proctoring integrity panel (integrity score, events grouped by type with time ranges and severity badges)
- PDF download button (exports via `/api/reports/[sessionId]/pdf` using @react-pdf/renderer)

---

## 12. Candidate Interview Flow

```
/interview/[token]          ← Landing page (consent, name entry)
    │
    ├── status = expired      → ExpiredState (cannot proceed)
    ├── status = completed    → CompletedScreen (permanent, link cannot be reused)
    └── status = pending      → ConsentButton → start
                                        │
                              /interview/[token]/check   ← Camera/mic check
                                        │
                              /interview/[token]/room    ← Live interview
                                        │
                                  on complete → 5-second countdown
                                             → window.close()
                                             → about:blank fallback (300ms later)
```

**Link expiry enforcement:**
- API returns `409` for completed sessions, `410` for expired — room page redirects on both
- `CompletedScreen` shows a permanent "link has been permanently closed" message
- Copy link button on the recruiter invite page shows "Link Expired" for `completed`, `shortlisted`, `rejected`, `expired` statuses

---

## 13. Authentication & Security

- **Recruiter auth**: `better-auth` with email/password. All dashboard API routes verify session via `auth.api.getSession()`
- **Candidate access**: Token-based (UUID in URL). No login required — the UUID token IS the credential
- **Ownership checks**: All recruiter API routes join through `recruiters.better_auth_user_id` — a recruiter can only access their own jobs/sessions
- **SQL injection**: All queries use parameterised `pool.query($1, [value])` — no string concatenation
- **FK integrity**: Cascade deletes on job → sessions → turns. `transcript_turns.question_id` is nullified (not cascade-deleted) when questions are regenerated — history preserved

---

## 14. Environment Variables Required

```env
# Auth
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000

# Database (DATABASE_URL — see .env.example)
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/ai_interview

# AI — interview brain + scoring + question generation
OPENAI_API_KEY=

# Real-time STT (live interview)
ASSEMBLYAI_API_KEY=

# TTS — Maya's voice
# Uses OPENAI_API_KEY via /api/speak

# Video infrastructure
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=   # wss://...  (used by browser, must be NEXT_PUBLIC_)

# Email
RESEND_API_KEY=
RESEND_FROM_EMAIL=

# Voice Lab only (not used in live interviews)
DEEPGRAM_API_KEY=
GLADIA_API_KEY=
```

---

## 15. Local Development

```bash
# Start local Postgres in Docker
npm run db:local:up

# Run DB migrations (db/migrations/ — run in order; or npm run db:local:setup)
# 000_better_auth.sql
# 001_core_tables.sql
# 002_rls_policies.sql (optional for local)
# 003_storage.sql (optional — recordings use local filesystem by default)

# Start dev server
npm run dev
```

The local DB runs at `postgresql://postgres:postgres@127.0.0.1:54322/ai_interview` via Docker Compose.

---

## 16. Key Design Principles

**1. No candidate accounts** — the UUID token in the URL is the full credential. Reduces friction from "create account" to "click link".

**2. Adaptive interviewing, not a script** — GPT-4o decides every turn what to do next based on coverage, probe counts, and uncovered categories. The interview feels conversational, not robotic.

**3. Pre-warm everything** — WebSocket, AudioContext, and mic are all warmed before the candidate needs them. Audio is buffered from the first click and flushed to AssemblyAI the moment the connection is ready — no first words dropped.

**4. Proctoring without false positives** — Conservative thresholds: 25 continuous seconds of absence before flagging `no_face`, strict bright-pixel range for phone detection. A candidate glancing away to think does not get penalised.

**5. Graceful degradation** — AssemblyAI → Gladia STT fallback. Pre-warmed mic → fresh `getUserMedia` fallback. All error states surface clean UI messages.

**6. Data integrity over convenience** — Transcript turns are never deleted when questions are regenerated. History is preserved, FK links are nullified. Sessions that are `completed` can never be re-entered.


---

## 1. What This Project Does

**Screeno** is a fully automated AI-powered recruitment screening platform. A recruiter creates a job, and the system takes over the entire first-round interview process:

1. Recruiter creates a job and defines competencies
2. AI generates tailored interview questions from the job description
3. Recruiter sends an email invite link to the candidate
4. Candidate clicks the link, passes consent, and is interviewed by **Maya** — an AI voice interviewer
5. Maya conducts a full spoken, adaptive conversation — asking questions, probing weak answers, and knowing when to close
6. The session is recorded (video + audio), transcript is saved, and each answer is scored by AI
7. Recruiter reviews a report: AI summary, competency scores, video recording, proctoring integrity score

No human is needed in the loop until the recruiter reviews the report.

---

## 2. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Framework** | Next.js 14 (App Router) | Full-stack in one repo — API routes + React UI, server components for DB queries |
| **Language** | TypeScript | Type safety across DB types, API contracts, AI response shapes |
| **Styling** | Tailwind CSS + custom design tokens | Utility-first with consistent design system (violet accent, white cards) |
| **Database** | PostgreSQL (via `pg` pool) | Relational data fits the recruiter → job → session → turn hierarchy perfectly |
| **Auth** | better-auth | Drop-in email/password auth with database hooks — auto-creates recruiter row on sign-up |
| **Email** | Resend + React Email | Transactional invite emails with responsive HTML templates |
| **Video infra** | LiveKit (WebRTC) | Manages candidate camera/mic tracks, handles reconnection, provides clean React hooks |
| **Video recording** | MediaRecorder API | Records LiveKit tracks in 5-second chunks, uploads to local filesystem |
| **Speech-to-Text** | AssemblyAI v3 WebSocket | Real-time PCM streaming STT with end-of-turn detection and keyword boosting |
| **Text-to-Speech** | OpenAI TTS-1 `nova` | Single-provider TTS for Maya to reduce voice latency variance and simplify operations |
| **AI Brain** | OpenAI GPT-4o-mini | Powers Maya's adaptive question selection, per-answer scoring, and final summary |
| **PDF parsing** | pdf-parse | Extracts text from uploaded resumes for resume-mode interviews |
| **State** | React hooks + useRef | All interview state lives in `useInterview` hook; refs avoid stale-closure bugs in async callbacks |
| **Charts** | Recharts | Competency score radar/bar charts in the report |

---

## 3. Database Schema

```
recruiters ─────────────── (one per HR user, linked to better-auth)
    │
    └── jobs ──────────────── (job postings with title, description, mode)
            │
            ├── questions ──── (interview questions — AI-generated or manual)
            ├── scoring_rubrics (competencies with weights, e.g. "Problem Solving: 30%")
            └── interview_sessions ── (one per candidate invite)
                        │
                        ├── transcript_turns ── (every spoken turn, both roles)
                        ├── question_scores ──── (AI score 1–10 per answer)
                        ├── analysis_results ─── (final summary, recommendation)
                        └── proctoring_events ── (integrity violations during interview)
```

**Key design decisions:**
- `interview_sessions.token` is the UUID passed in the candidate URL — never expose the numeric `id` to candidates
- `transcript_turns.question_id` is nullable — transcript history is preserved even if questions are deleted/regenerated
- `expires_at` defaults to 7 days; status is `pending → in_progress → completed`
- `integrity_score` starts at 100; each proctoring event deducts penalty points

---

## 4. Interview Question Modes

| Mode | What happens |
|---|---|
| `ai_only` | GPT-4o-mini generates 7 questions from the JD on job creation |
| `custom_only` | Recruiter manually writes all questions |
| `mixed` | AI generates a base set; recruiter can edit/add more |
| `resume` | Resume is parsed on candidate arrival; questions are generated from the CV |

---

## 5. The AI Interview Engine (`useInterview` hook)

This is the core of the product. It orchestrates a real-time spoken interview as a state machine:

```
idle → intro → listening ⇄ processing ⇄ speaking → completed
```

### State machine breakdown

| State | What's happening |
|---|---|
| `idle` | Waiting for candidate to click Start |
| `intro` | Fetching opening greeting from GPT → playing Maya's voice via TTS |
| `listening` | AssemblyAI WebSocket active, capturing candidate's speech in real-time PCM |
| `processing` | Candidate finished speaking → calling `/api/sessions/[token]/turn` → GPT decides next action |
| `speaking` | TTS audio for Maya's next question is playing |
| `completed` | GPT returned `"action": "close"` → interview over |

### How Maya decides what to say next

Every candidate turn triggers a GPT-4o-mini call with a structured system prompt containing:
- All unasked questions with IDs, categories, difficulty
- Competencies to cover
- Current turn number and max turns
- Probe counts per question (max 2 probes per question before moving on)
- Uncovered categories (Maya must cover all categories before closing)

GPT returns JSON:
```json
{
  "action": "probe" | "next" | "close",
  "question": "Maya's next spoken line",
  "question_id": "uuid or null",
  "notes": "internal reasoning"
}
```

This makes Maya adaptive — she digs deeper on shallow answers, skips to the next topic when satisfied, and closes naturally when coverage is complete.

### Zero-latency listen start (pre-warm pattern)

Maya's TTS plays while the AssemblyAI WebSocket is already connecting in the background (`activeRef.current = false` discards audio during TTS). The moment TTS ends, `activate()` flips the ref to `true` — no delay between Maya finishing and capturing the candidate's first word.

---

## 6. Real-Time Speech Capture (`useSpeechCapture` hook)

- Opens an **AssemblyAI v3 WebSocket** with PCM Int16 audio at 16kHz
- Uses `ScriptProcessorNode` to convert Float32 mic samples → Int16 binary frames sent every 2048 samples (~128ms)
- AssemblyAI returns `Turn` events with `end_of_turn: true` when it detects the candidate has finished speaking
- Key tuning parameters:
  - `max_turn_silence: 2500ms` — candidate gets 2.5s of silence before turn is considered done
  - `min_turn_silence: 1000ms` — prevents accepting a pause mid-sentence
  - `end_of_turn_confidence_threshold: 0.5`
- Short-answer protection: if the turn has < 3 words, a 3-second grace timer waits before accepting (prevents cutting off "No, I think..." type answers)
- `keywords` array passes job-specific vocabulary (job title, tech stack) to AssemblyAI for better accuracy on domain terms

---

## 7. Text-to-Speech (`/api/speak` + `useAudioPlayer`)

**Provider: OpenAI TTS-1 `nova`**
- Single production TTS provider
- 15-second timeout
- Same API surface — returns `audio/mpeg`

The audio plays via a plain `<audio>` element. The `speak()` function returns a Promise that resolves when playback ends, allowing the interview state machine to await it before starting to listen.

---

## 8. Video Recording (`useVideoRecorder` hook)

- Uses `MediaRecorder` on the LiveKit `LocalVideoTrack` + `LocalAudioTrack` streams
- Records in `video/webm; codecs=vp8,opus`
- Uploads a new chunk every **5 seconds** to `/api/recordings/[sessionId]/chunk?index=N`
- Chunks are stored on disk at `recordings/[sessionId]/chunk-N.webm`
- On playback (report page), chunks are concatenated and served as a single stream
- Recording stops automatically when the interview completes; LiveKit tracks are stopped so the browser camera/mic indicator turns off

---

## 9. Proctoring (`useProctor` hook)

Runs silently during the entire interview. Detects:

| Event | Method | Severity | Penalty |
|---|---|---|---|
| Tab switch | `visibilitychange` | medium | -10 |
| Window blur | `blur` event | low | -5 |
| Multiple faces | Canvas pixel sampling | high | -15 |
| No face / candidate absent | Canvas skin-tone ratio | medium | -8 |
| Gaze away | Estimated from face position | low | -3 |
| Paste detected | `paste` event | low | -5 |
| DevTools open | Window size heuristic | high | -20 |
| Phone detected | Canvas analysis | high | -20 |

**Face detection** works by sampling canvas pixels from the video element and computing the ratio of skin-tone pixels. Tuned conservatively:
- Threshold: `skinRatio < 0.01` (candidate must be almost completely absent)
- Checks every 5 seconds
- Requires 5 consecutive fails (25 continuous seconds) before flagging — prevents false positives when candidate looks down to read

Each event is posted to `/api/sessions/[token]/proctor` and stored in `proctoring_events`. The report page shows a grouped summary with an integrity score.

---

## 10. Recruiter Dashboard

| Page | What it does |
|---|---|
| `/dashboard` | Overview stats — total jobs, sessions this week, recent activity |
| `/dashboard/jobs` | Job card grid — create, view status, quick actions |
| `/dashboard/jobs/new` | Create job form — title, dept, description, question mode (colored 2×2 card grid) |
| `/dashboard/jobs/[id]/questions` | View/edit AI-generated questions, add custom ones, regenerate AI set |
| `/dashboard/jobs/[id]/invite` | Send invite emails, see all candidates with status + link state |
| `/dashboard/jobs/[id]/edit` | Edit title, description, status |
| `/dashboard/candidates` | Cross-job candidate table |
| `/dashboard/reports/[sessionId]` | Full interview report (below) |
| `/dashboard/avatar` | Select Maya's avatar |
| `/dashboard/voice-test` | Voice Lab — test AssemblyAI, Deepgram, Gladia, Web Speech API side by side |

---

## 11. Interview Report Page

Split into a 2-column layout (`lg:grid-cols-3`):

**Left column (2/3):**
- AI-generated summary paragraph
- Strengths and Concerns
- Per-question score cards (score 1–10, reasoning, competency breakdown)
- Full transcript (interviewer + candidate turns)

**Right column (1/3):**
- Video recording player (dark theme, 190px height, lazy-loads on play)
- Competency scores (weighted bar chart)
- Proctoring integrity panel (score, grouped events by type with time ranges, severity badges)

---

## 12. Candidate Interview Flow

```
/interview/[token]          ← Landing page (consent, name entry)
    │
    ├── status = expired      → ExpiredState (cannot proceed)
    ├── status = completed    → CompletedScreen (permanent, no reuse)
    └── status = pending      → ConsentButton → start
                                        │
                              /interview/[token]/check   ← Camera/mic check
                                        │
                              /interview/[token]/room    ← Live interview
                                        │
                                  on complete → 5s countdown → window.close()
                                               → about:blank fallback
```

**Link expiry enforcement:**
- API returns `409` for completed sessions, `410` for expired — room page redirects on both
- `CompletedScreen` shows a permanent "link has been permanently closed" message
- Copy link button on the recruiter invite page shows "Link Expired" for completed/rejected/shortlisted sessions

---

## 13. Authentication & Security

- **Recruiter auth**: `better-auth` with email/password. All dashboard API routes verify session via `auth.api.getSession()`
- **Candidate access**: Token-based (UUID in URL). No login required — token IS the credential
- **Ownership checks**: All recruiter API routes join through `recruiters.better_auth_user_id` — a recruiter can only access their own jobs/sessions
- **Input validation**: Zod schemas on all API POST bodies
- **SQL injection**: All queries use parameterised `pool.query($1, [value])` — no string concatenation
- **FK integrity**: Cascade deletes on job → sessions, sessions → turns. Nullify-on-delete for `transcript_turns.question_id` (history preserved when questions are regenerated)

---

## 14. Environment Variables Required

```env
# Database
DATABASE_URL=postgresql://...

# Auth
BETTER_AUTH_SECRET=

# AI
OPENAI_API_KEY=           # GPT-4o-mini (interview brain + scoring + question gen)
ASSEMBLYAI_API_KEY=       # Real-time STT
# OPENAI_API_KEY also powers TTS via /api/speak

# Video infrastructure
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=  # wss://...

# Email
RESEND_API_KEY=

# Optional STT alternatives (Voice Lab only)
DEEPGRAM_API_KEY=
GLADIA_API_KEY=
```

---

## 15. Local Development

```bash
# Start local Postgres in Docker
npm run db:local:up

# Run DB migrations (db/migrations/ — psql or npm run db:local:migrate)
# db/migrations/000_better_auth.sql
# db/migrations/001_core_tables.sql
# db/migrations/002_rls_policies.sql

# Start dev server
npm run dev
```

The local DB runs at `postgresql://postgres:postgres@127.0.0.1:54322/ai_interview` via Docker Compose.

---

## 16. Key Design Principles

**1. No candidate accounts** — the UUID token in the URL is the full credential. Reduces friction from "create account" to "click link".

**2. Adaptive interviewing, not a script** — GPT decides every turn what to do next based on coverage, probe counts, and uncovered categories. The interview feels conversational, not robotic.

**3. Pre-warm everything** — WebSocket, AudioContext, and mic are all warmed before the candidate needs them. Zero-latency transitions between Maya speaking and listening capturing.

**4. Proctoring without false positives** — Conservative thresholds: 25 continuous seconds absent before flagging, strict skin-tone threshold. A candidate glancing away to think does not get penalised.

**5. Graceful degradation** — AssemblyAI → Gladia STT fallback. Pre-warmed mic → fresh getUserMedia fallback. All error states surface clean UI messages, never raw stack traces to the user.

**6. Data integrity over convenience** — Transcript turns are never deleted when questions are regenerated. History is preserved, FK links are nullified. Sessions that are completed can never be re-entered.
