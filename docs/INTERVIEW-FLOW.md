# Interview Flow — Complete Technical Reference

> **Purpose**: Understand exactly what happens during a live interview session, debug failures quickly, and know where to improve things.

---

## 1. High-Level Flow

```
Candidate opens link
       │
       ▼
┌─────────────────┐
│  Consent / Check │  /interview/[token]
│  page            │  → camera + mic test
└────────┬────────┘
         │ Click "Join Interview"
         ▼
┌─────────────────┐
│  Room page       │  /interview/[token]/room
│  (LiveKit room)  │  → video + controls
└────────┬────────┘
         │ Click "Start Interview"
         ▼
┌─────────────────────────────────────────────────────┐
│                  INTERVIEW LOOP                      │
│                                                     │
│  1. unlockAudio()     ← must happen on button click │
│  2. Fetch opening question from GPT-4o              │
│  3. Pre-warm STT while TTS plays                    │
│  4. Play Maya's TTS audio                           │
│  5. Detect STT alive → reconnect if dead            │
│  6. Listen to candidate                             │
│  7. Candidate stops speaking → detect silence       │
│  8. Send transcript to GPT-4o → get next question   │
│  9. Score answer in parallel (GPT-4o-mini)          │
│  10. Repeat from step 3 until close action          │
└─────────────────────────────────────────────────────┘
         │ GPT returns action:"close"
         ▼
┌─────────────────┐
│  End session     │  POST /api/sessions/[token]/end
│  Generate report │  → analysis_results
└─────────────────┘
```

---

## 2. Detailed Turn-by-Turn Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ONE TURN (repeated)                           │
│                                                                      │
│  ┌──────┐   ┌─────────────────┐   ┌──────────────┐   ┌──────────┐  │
│  │ GPT  │   │  TTS (OpenAI)   │   │     STT       │   │  Scorer  │  │
│  │ 4o   │   │  nova voice     │   │  Deepgram    │   │ 4o-mini  │  │
│  └──┬───┘   └───────┬─────────┘   └──────┬───────┘   └────┬─────┘  │
│     │               │                    │                 │        │
│     │◄──question─── │                    │                 │        │
│     │               │                    │                 │        │
│     │    ┌──────── TTS playing ────────┐ │                 │        │
│     │    │ • fetch /api/speak          │ │                 │        │
│     │    │ • MediaSource stream audio  │ │                 │        │
│     │    │ • ~8s fetch + N seconds TTS │ │                 │        │
│     │    │                            │ │                 │        │
│     │    │   [transcript state reset]  │ │                 │        │
│     │    │   (Deepgram starts fresh    │ │                 │        │
│     │    │    after TTS finishes)      │ │                 │        │
│     │    └────────────────────────────┘ │                 │        │
│     │                                   │                 │        │
│     │          TTS finishes             │                 │        │
│     │    ┌──── Fresh STT start ─────────┤                 │        │
│     │    │ token → WS → Metadata        │                 │        │
│     │    │ pre-roll flushed (1.5 s)     │                 │        │
│     │    │ KeepAlive every 8 s          │                 │        │
│     │    └──── activate() ─────────────►activeRef=true   │        │
│     │                                   │                 │        │
│     │              ┌── Candidate speaks ─────────────────┐│        │
│     │              │   PCM → Int16 → WebSocket           ││        │
│     │              │   Deepgram returns:                  ││        │
│     │              │   • Results (interim, is_final)     ││        │
│     │              │   • Results with speech_final=true  ││        │
│     │              └─────────────────────────────────────┘│        │
│     │                                   │                 │        │
│     │◄──────── candidate transcript ────┘                 │        │
│     │                                                     │        │
│     ├──── POST /api/sessions/[token]/turn ────────────────►score   │
│     │     body: { candidate_answer, turn_index }          │        │
│     │                                                     │        │
│     │◄── { action, question, question_id, turn_index } ───┘        │
│     │                                                              │
│     │  action = "next"  → repeat loop                             │
│     │  action = "probe" → follow-up on same question              │
│     │  action = "close" → end interview                           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Map

| Component | File | Does What |
|-----------|------|-----------|
| `useInterview` | `src/hooks/useInterview.ts` | Master orchestrator — runs the full turn loop + EOT fusion |
| `useSpeechCapture` | `src/hooks/useSpeechCapture.ts` | STT: Deepgram Nova-3 primary + Web Speech fallback |
| `computeEotDecision` | `src/lib/eotDecision.ts` | Linguistic + confidence signals for answer completion |
| `useAudioPlayer` | `src/hooks/useAudioPlayer.ts` | TTS: MediaSource streaming of OpenAI audio |
| `useProctor` | `src/hooks/useProctor.ts` | Integrity monitoring (tab, face, phone, devtools) |
| `useVideoRecorder` | `src/hooks/useVideoRecorder.ts` | Records video chunks to `/api/recordings/` |
| Room page | `src/app/interview/[token]/room/page.tsx` | UI: video, controls, debug logs |
| Turn API | `src/app/api/sessions/[token]/turn/route.ts` | GPT-4o brain + GPT-4o-mini scorer |
| Speak API | `src/app/api/speak/route.ts` | Proxies OpenAI TTS |
| Deepgram token | `src/app/api/deepgram/token/route.ts` | Issues 60s-TTL Deepgram access token |

---

## 4. STT Provider Chain (Fallbacks)

```
Start()
  │
  ├─► 1. Deepgram Nova-3   wss://api.deepgram.com/v1/listen
  │       ├─ Auth via Sec-WebSocket-Protocol: ['token', tempToken]
  │       ├─ Server-side VAD + 300ms endpointing + utterance_end events
  │       ├─ KeepAlive ping every 8s prevents idle disconnect
  │       ├─ 1.5s pre-roll buffer flushed on Metadata → no first-word loss
  │       └─ FAIL (network / quota / mid-stream drop) ──────┐
  │                                                          ▼
  └─► 2. Web Speech API (browser built-in)
          ├─ Free, always available in Chromium browsers
          └─ Lower accuracy but interview never stalls
```

### Why Deepgram (not AssemblyAI)
| Criterion | Old (AssemblyAI v3) | New (Deepgram Nova-3) |
|---|---|---|
| Idle disconnect | 10s → 3006 (broken) | 12s but `KeepAlive` keeps it forever |
| First-word loss | Common | Solved with pre-roll buffer + server VAD |
| Indian English accuracy | ~89% | ~92% |
| Cost / 30 min interview | ~$0.45 | ~$0.13 |
| API stability | Beta v3, breaking changes | GA, stable since 2025 |
| Auth in browser | Token + URL param | Token via `Sec-WebSocket-Protocol` header |

### Key Deepgram URL params we use
```
model=nova-3
language=en
encoding=linear16&sample_rate=16000&channels=1
interim_results=true
smart_format=true&punctuate=true
endpointing=300              ← silence ms before utterance boundary
utterance_end_ms=1000        ← silence ms before UtteranceEnd fires
vad_events=true              ← server emits SpeechStarted events
keywords=React:2,TypeScript:2  ← values from `/api/deepgram/token` passed into `listen.live()`
```

### End-of-turn detection (fusion)
We no longer gate the turn API on `speech_final` alone. The interview client:

1. **Deepgram signals**
   - `speech_final=true` on a transcribed chunk still marks an utterance boundary.
   - **`UtteranceEnd`** fires after sustained silence (`utterance_end_ms`, default 1000 ms) — when the linguistic model suspects an incomplete answer (“and…”, “first…”), we **wait for `UtteranceEnd`** before committing when possible (with a **4.5 s fallback** if the event never arrives).
   - Optional **Metadata VAD** (`SpeechStarted` / speech-end hints) resets scheduling when the SDK exposes them — cancels stale debounces if the candidate resumes.
2. **Text heuristics** (`computeEotDecision` in `src/lib/eotDecision.ts`): trailing joiners, enumeration without a closer, fillers (“let me think…”), and explicit closure phrases adjust **debounce** (yield buffer ~120–360 ms) vs **wait-for-UtteranceEnd**.
3. **Very short answers** use the **full accumulated transcript**, not only the last segment: if Deepgram hears fewer than **2 words** overall, `useInterview` applies a **3 s continuation window** (same intent as the old hook-level timer, without mis-firing after a long answer that ends with “Yes”).
4. **UI**: while `state=listening`, `candidateListeningPhase` (`speaking` | `pause` | `committing` | `idle`) is surfaced next to Maya’s status.

---

## 5. Known Failure Points & Fixes

### ❌ Candidate speaks but transcript never comes (interview stuck)
**Old root cause (AssemblyAI)**: Idle WS dropped (code 3006). Suspended AudioContext after reconnect.  
**Fix in place (Deepgram migration)**:
1. KeepAlive ping every 8s — Deepgram never drops idle.
2. `audioCtx.resume()` on every new AudioContext.
3. 1.5 s pre-roll buffer flushed when server sends `Metadata` → no first-word loss.
4. Web Speech fallback if Deepgram disconnects mid-stream → interview never stalls.

**Debug signal**: Look for `Pre-roll flushed` and `Deepgram session ready — speak now` after STT start.

---

### ❌ Maya speaks but candidate hears nothing
**Root cause**: Browser autoplay policy blocks `audio.play()` when called after async work (LLM fetch takes 5s, user gesture expires).  
**Fix applied**: `unlockAudio()` called synchronously at the very start of `startInterview`, before any `await`.  
**Debug signal**: Look for `audio.play() blocked` in TTS logs.

---

### ❌ `phone_detected` / proctoring 500 error
**Root cause**: `proctoring_events` DB constraint only had 6 event types; hook fires 11.  
**Fix applied**: Migration `009_proctor_event_types.sql` + API-level `23514` error catch.  
**Run**: `npm run db:local:migrate`

---

### ❌ `column "question_mode" does not exist`
**Root cause**: Local DB only has base migrations (000, 001); missing 005+.  
**Fix applied**: `npm run db:local:setup` now resets and applies all migrations.  
**Run**: `npm run db:local:setup`

---

### ❌ `column "company_intro" does not exist`
**Root cause**: `008_recruiter_company_intro.sql` not applied.  
**Fix applied**: Queries now use `to_jsonb(r)->>'company_intro'` (safe against missing column) + migration.

---

### ❌ Recording chunks 404
**Root cause**: `/api/recordings/[sessionId]/chunk` route didn't exist.  
**Fix applied**: Routes created at `src/app/api/recordings/[sessionId]/chunk/route.ts` and `stream/route.ts`. Chunks saved to `recordings/{sessionId}/{index}.webm`.

---

## 6. Debug Log Guide

The debug log panel (bottom of interview room — click to expand) shows real-time pipeline events.

| Tag | Colour | Means |
|-----|--------|-------|
| `[FLOW]` | Purple | Interview state machine transitions |
| `[LLM]` | Green | GPT-4o requests + responses |
| `[TTS]` | Orange | Text-to-speech fetch + playback |
| `[STT]` | Blue | Speech recognition events |
| `[MIC]` | Pink | Microphone capture events |

### Good turn sequence
```
[FLOW] Starting interview — fetching opening question
[LLM]  SUCCESS  Opening: "Hello, welcome! I'm Maya…"
[TTS]  INFO     Requesting speech: "Hello, welcome!…"
[TTS]  SUCCESS  Playback finished
[FLOW] INFO     Opening question done — starting STT
[MIC]  INFO     TTS done — starting STT…
[STT]  INFO     Starting Deepgram capture session N
[STT]  INFO     Fetching Deepgram temp token…
[STT]  SUCCESS  Token OK — requesting mic access…
[STT]  SUCCESS  Mic granted — connecting to Deepgram (5 keywords)…
[STT]  INFO     WebSocket open — initialising audio…
[STT]  INFO     Pre-roll flushed (6 frames ≈ 1536 ms)
[STT]  SUCCESS  Deepgram session ready — speak now
[STT]  SUCCESS  Capture activated — listening for candidate
[STT]  INFO     [final segment] "The difference between GET and POST…"
[STT]  SUCCESS  [END_OF_UTTERANCE] "…is that POST has a body."
[STT]  INFO     End-of-turn confidence: 94%
[FLOW] Sending transcript to GPT-4o…
[LLM]  SUCCESS  Action: next — "Good explanation! Now let's…"
[TTS]  SUCCESS  Playback finished
```

### What "stuck" looks like (no transcript)
```
[STT]  SUCCESS  Capture activated — listening for candidate
                                              ← user speaks but no [final segment] line
[STT]  WARN     Deepgram disconnected mid-stream (1006: ...) — switching to Web Speech…
[STT]  SUCCESS  Web Speech fallback active     ← interview keeps going
```
If even Web Speech fails, you'll see `STT unavailable.` — usually a browser permission issue.


---

## 7. API Endpoints Used During Interview

| Endpoint | Method | Called When |
|----------|--------|-------------|
| `/api/sessions/[token]/turn` | POST | Every turn (opening + each answer) |
| `/api/speak` | POST | After each GPT response |
| `/api/deepgram/token` | POST | Before each STT session — issues 60s temp token |
| `/api/sessions/[token]/proctor` | POST | Every proctoring violation |
| `/api/recordings/[id]/chunk` | POST | Every 5 seconds while recording |
| `/api/sessions/[token]/end` | POST | Interview complete or candidate leaves |

---

## 8. Interview States

```
idle
  │ startInterview()
  ▼
intro  (fetching opening from GPT)
  │ LLM returns
  ▼
speaking  (TTS playing Maya's voice)
  │ TTS finishes + STT activates
  ▼
listening  (candidate speaks → Deepgram streams transcript)
  │ speech_final=true received
  ▼
processing  (sending transcript to GPT, scoring in parallel)
  │ GPT returns action:"next" or "probe"
  ▼
speaking  → listening  → processing  → (repeat)
  │ GPT returns action:"close"
  ▼
completed  (session ended, tab shows close message)
```

---

## 9. Quick Commands

```bash
# Reset + fully rebuild local DB (destroys data)
npm run db:local:setup

# Apply only new migrations (preserves data)
npm run db:local:migrate

# Start dev server
npm run dev

# Run linter
npm run lint
```
