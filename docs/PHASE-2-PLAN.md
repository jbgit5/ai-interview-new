# AI Interview Platform — Phase 2 Implementation Plan

> Status: Phase A ✅ Phase B ✅ Phase C ✅ Phase D 🔄 in progress

---

## Background

Phase 1 delivered: auth, local DB, dashboard shell, Jobs CRUD, questions, email invites.  
Phase 2 is the live interview experience quality and reliability upgrade.

---

## Decisions locked in

| Decision | Choice |
|---|---|
| Opening tone | Professional and concise (15-20 sec spoken) |
| Company details source | Recruiter-configured sidebar field on job (max 300 chars server-side) |
| Off-topic policy | Gentle redirect **once** per session, then continue |
| Follow-up mode | Hybrid — fixed base questions + AI probes |
| Probe depth per question | Max 2 (unchanged) |
| Build priority | Welcome/boundary first, then probe quality, then reliability |

---

## Phases

### Phase A — Welcome intro + company brand ✅

**Goal:** Maya opens with a warm 15-20 second intro mentioning APPhelix before the first question.

**Changes:**
- `db/migrations/007_company_intro.sql` — `company_intro TEXT` on `jobs`; `offtopic_redirect_issued BOOLEAN` on `interview_sessions`
- `src/types/index.ts` — `Job.company_intro`, `InterviewSession.offtopic_redirect_issued`
- `src/lib/prompts.ts` — `buildOpeningPrompt()` accepts `companyIntro?`; phrased as natural 4-5 sentences
- `src/app/api/jobs/route.ts` — POST persists `company_intro` (server-side 300-char trim)
- `src/app/api/jobs/[id]/route.ts` — PATCH persists `company_intro`
- `src/app/api/sessions/[token]/turn/route.ts` — opening turn passes `company_intro` to prompt
- `src/app/dashboard/jobs/new/page.tsx` — company intro textarea with live char counter
- `src/app/dashboard/jobs/[jobId]/edit/page.tsx` — same field for existing jobs

**Run migration:**
```bash
psql "$DATABASE_URL" -f db/migrations/007_company_intro.sql
```

---

### Phase B — Off-topic boundary ✅

**Goal:** One gentle spoken redirect when candidate gives a clearly irrelevant answer.

**Changes:**
- `src/lib/prompts.ts` — `buildScoringPrompt()` returns `is_relevant: boolean` + `relevance_note`
- `src/app/api/sessions/[token]/turn/route.ts` — parse scoring before persisting; if `is_relevant === false` and `offtopic_redirect_issued === false`, return Maya boundary statement and set flag
- **Boundary text:** "I appreciate you sharing that, but as your AI interviewer today I'm here to focus only on questions relevant to this role — I'm not able to step outside the interview context. Let's get back on track: [current question]"

**Policy:** One redirect maximum per session. After that, interview continues without interruption.

---

### Phase C — Hybrid probe quality controls ✅

**Goal:** Probes are contextually varied, not rephrases of the original question.

**Changes:**
- `src/lib/prompts.ts` — Rules 9 and 10 added to `buildInterviewSystemPrompt()`:
  - Rule 9: First probe = specific example / depth / clarification from candidate's answer
  - Rule 10: Second probe = outcome / impact / lesson; never same opening words as original question

**Fixed base questions are preserved.** GPT picks which base question to ask next; probes are AI-generated follow-ups on the same `question_id`.

---

### Phase D — Reliability and observability 🔄

#### D1 — Intent fix: "yes" maps to continue ✅
When system asks "continue or move next?", candidate saying "yes" or "yeah" now correctly maps to continue.

#### D2 — Turn API retry logic ✅
Network errors on `/turn` are retried up to 2 times (1s, 2s delay) before entering error state. Logs show retry count.

#### D3 — STT total failure UX ✅
When both AssemblyAI and Gladia fail, error message is descriptive: "Speech recognition unavailable — both providers failed. Please check your microphone and internet connection, then reload."

#### D4 — Per-turn latency instrumentation ✅
`console.log` structured JSON at every turn:
```json
{
  "event": "turn_metrics",
  "session_id": "...",
  "turn_index": 3,
  "action": "next",
  "db_session_ms": 12,
  "db_parallel_ms": 48,
  "llm_ms": 920,
  "write_ms": 22,
  "total_ms": 1002,
  "brain_prompt_tokens": 1840,
  "brain_completion_tokens": 110,
  "scoring_total_tokens": 430,
  "offtopic_redirect": false
}
```

#### D5 — TTS latency + character count ✅
```json
{ "event": "tts_metrics", "chars": 214, "tts_fetch_ms": 780 }
```

---

## Remaining phases (planned, not yet implemented)

### Phase E — Cost calculator per interview
- Aggregate `brain_prompt_tokens`, `brain_completion_tokens`, `scoring_total_tokens` per session from turn route logs or a DB table
- Track TTS char count per session from speak route
- Cost estimates: GPT-4o $2.50/1M input + $10/1M output; GPT-4o-mini $0.15/$0.60; TTS-1 $15/1M chars
- Surface total cost on interview report page

### Phase F — Latency observability dashboard
- Store per-turn metrics from D4 in a `turn_metrics` DB table
- Show p50/p95 turn latency in recruiter dashboard
- Alert if p95 > 3s for a given session

### Phase G — Web Speech API emergency fallback
- Third-tier STT when both AssemblyAI and Gladia fail
- Add to `useSpeechCapture.ts` after Gladia failure path
- Lower accuracy but keeps interview alive

---

## Verification checklist

| Test | Pass criteria |
|---|---|
| Opening intro | 15-20 sec spoken; mentions APPhelix when intro configured; falls back gracefully when empty |
| Off-topic redirect | First irrelevant answer → Maya redirects; second irrelevant answer → interview continues without re-redirecting |
| Probe variety | Two consecutive probes on same question use different angles (no repeated opening words) |
| "yes" continuation | Candidate says "yes" when asked continue-or-move-next → continues the answer |
| Turn API retry | Simulated network error → 2 retries logged → success or graceful error |
| STT failure | Both providers fail → descriptive error message shown (not generic "error") |
| Latency log | `turn_metrics` JSON appears in server logs for every non-opening turn |
| TTS log | `tts_metrics` JSON appears for every speak call |
| Build | `npm run build` → `✓ Compiled successfully` |

---

## Key files reference

| File | Purpose |
|---|---|
| `src/lib/prompts.ts` | All AI prompt builders |
| `src/app/api/sessions/[token]/turn/route.ts` | Turn orchestration, probe/next/close, off-topic |
| `src/hooks/useInterview.ts` | Client interview state machine |
| `src/hooks/useSpeechCapture.ts` | STT provider lifecycle and fallback |
| `src/hooks/useAudioPlayer.ts` | TTS playback |
| `src/app/api/speak/route.ts` | TTS endpoint |
| `db/migrations/007_company_intro.sql` | Schema: company_intro, offtopic_redirect_issued |
| `docs/SCALE-READINESS.md` | Vendor capacity checklist before load testing |
| `scripts/load-test.js` | k6 staged load test (smoke → 25 → 50 → 100 → 200) |
