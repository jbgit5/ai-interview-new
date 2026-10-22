# Screeno — Telemetry & Observability Architecture

> **Purpose:** Production-grade observability for the realtime AI interview platform. Use this document to reuse the same decisions in any context (new hires, vendors, incident reviews) and to **implement in small phases** without losing the overall design.  
> **Companion:** See [`PROJECT-OVERVIEW.md`](./PROJECT-OVERVIEW.md) for product/stack context and [`INTERVIEW-FLOW.md`](./INTERVIEW-FLOW.md) for the interview loop.

---

## Table of contents

1. [Goals and what we measure](#1-goals-and-what-we-measure)
2. [Stack alignment](#2-stack-alignment)
3. [Telemetry architecture (three layers)](#3-telemetry-architecture-three-layers)
4. [Session event logging](#4-session-event-logging)
5. [Metrics aggregation strategy](#5-metrics-aggregation-strategy)
6. [Dashboard architecture](#6-dashboard-architecture)
7. [Realtime analytics recommendations](#7-realtime-analytics-recommendations)
8. [Event schema design](#8-event-schema-design)
9. [Event naming conventions](#9-event-naming-conventions)
10. [Tracking map (metrics → events)](#10-tracking-map-metrics--events)
11. [Database table structure (PostgreSQL)](#11-database-table-structure-postgresql)
12. [WebSocket monitoring](#12-websocket-monitoring)
13. [Latency tracking (spans and SLIs)](#13-latency-tracking-spans-and-slis)
14. [AI behavior analytics](#14-ai-behavior-analytics)
15. [Session-level vs system-wide vs improvement over time](#15-session-level-vs-system-wide-vs-improvement-over-time)
16. [Implementation phases (incremental build)](#16-implementation-phases-incremental-build)
17. [Dashboard widgets and chart recommendations](#17-dashboard-widgets-and-chart-recommendations)
18. [Performance and safety considerations](#18-performance-and-safety-considerations)
19. [Quick reference checklist](#19-quick-reference-checklist)

---

## 1. Goals and what we measure

**Business / product:** Understand interview quality (probes, pacing, completion), regressions after deploys, and candidate-facing latency.

**Reliability:** STT/TTS/API failures, WebRTC (LiveKit) stability, reconnect loops.

**Scientific improvement:** Same schema over time, release markers, daily rollups, before/after comparisons.

### Signals to track (required for this platform)

| Area | Examples |
|------|-----------|
| Transcript latency | Time from end-of-speech signal → final STT text |
| AI decision latency | `/api/sessions/[token]/turn` duration (brain JSON returned) |
| Interruptions | VAD speech while Maya is speaking or overlapping turns |
| Candidate pauses | Listening phase: `pause` vs `speaking` duration |
| Probe triggers | Brain returns `action: probe` (and relate to question) |
| STT/TTS failures | Errors, reconnects, playback failures |
| WebSocket disconnects | AssemblyAI STT; LiveKit signaling / room events |
| Fallback usage | EOT fusion fallbacks (utterance timer, silence, etc.) |
| End-of-turn accuracy | Logged EOT source + confidence; optional human labels later |

---

## 2. Stack alignment

| Layer | Technology | Observability hook |
|-------|-------------|---------------------|
| App | Next.js 14 App Router | API route middleware, structured logs, `/api/telemetry/*` ingest |
| DB | PostgreSQL (`pg`) | Raw events + rollups + summaries |
| Realtime video | LiveKit | Connection lifecycle, disconnect reasons |
| STT | AssemblyAI v3 WebSocket | Open/close/latency/reconnect (client + optional proxy) |
| TTS | OpenAI TTS | Request, first byte, errors |
| AI | GPT-4o brain, GPT-4o-mini scorer | Latency, token usage, action distribution, parse errors |
| Session brain | `useInterview` + `/turn` | State machine, EOT fusion, fallbacks |

Instrument **client** (hooks) and **server** (routes) with the **same event envelope** so analytics stay consistent.

---

## 3. Telemetry architecture (three layers)

### Three pillars

| Pillar | Use for | Typical backends |
|--------|---------|------------------|
| **Traces / spans** | End-to-end “candidate stopped → Maya audio starts” | OpenTelemetry → Jaeger/Tempo, or vendor APM |
| **Metrics** | Histograms, counters, SLIs (p95, error rates) | Prometheus + Grafana, or Datadog |
| **Structured events** | Drill-down, session timelines, flexible attrs | PostgreSQL (+ optional ClickHouse/BigQuery at scale) |

### Pipeline split

| Path | Responsibility |
|------|----------------|
| **Real-time (ops)** | Metrics + optional Redis/stream for “last N minutes”; alerts on SLO breach |
| **Analytics (product)** | Append events → scheduled rollups → daily tables; trend vs release |
| **Debug** | Correlation `trace_id` on client + server; session timeline UI |

### Suggested ingestion

1. **Browser:** Small SDK or wrapper — batch events, POST to `POST /api/telemetry/batch` (auth via session token or signed payload).
2. **Server:** Next.js API routes emit identical schema when STT/TTS/turn completes.
3. **Future:** Queue + worker normalization (optional).

---

## 4. Session event logging

**Principle:** Append-only, one row per **meaningful** occurrence (not per animation frame). Internal key: `interview_sessions.id`; avoid exposing numeric id to candidates in telemetry APIs.

**Minimum lifecycle events**

`session.start_requested` → `session.started` → `interview.state_change` (idle → intro → listening → …) → `turn.*` / `ai.*` / `stt.*` / `tts.*` → `session.ended` or `session.aborted`.

**STT reliability (important for postmortems):**

- `stt.fallback` — Deepgram path failed or WebSocket closed **while the interview continued** on **Web Speech** (`attrs`: `from`, `to`, `stage` = `runtime_disconnect` | `connect_failed`, `deepgram_code`, `detail`). This is **not** the same as total STT failure (`stt.error` only fires when **both** providers fail).
- `stt.deepgram.error` — Deepgram SDK `Error` event payload (trimmed) for correlation with vendor status.
- `stt.fallback.ready` — First Web Speech `onresult` after a `stt.fallback` handoff; `attrs.ms_until_first_transcript_hypothesis` measures how long until any transcript hypothesis (interim or final) — use to judge **candidate-facing dead air** after Deepgram loss.
- `interview.state_change` — now includes **`duration_in_previous_state_ms`** (dwell in the `from` state) and optional **`interview_elapsed_ms_at_transition`** (wall ms since leaving `idle`) for **phase pacing** charts in Session analytics.
- In-room **developer log lines** (`addLog` in `useInterview`) are **not** persisted to PostgreSQL unless you enqueue matching telemetry events; the **Session analytics → Interview log by minute** view is driven by `session_telemetry_events` only.

**Instrumentation surfaces**

| Source | What to log |
|--------|--------------|
| `useInterview` | State transitions, EOT fusion, fallback timers, phase (listening/processing/speaking) |
| `useSpeechCapture` / STT | Connect, disconnect, final transcript timing, errors, reconnect |
| `/api/sessions/.../turn` | Start/end, model, outcome, latency, action |
| TTS path | Request, first audio, completion, error |
| `useLiveKit` | Connected, reconnecting, disconnected, track muted |
| Proctoring | Existing `POST .../proctor` — mirror critical counters into telemetry if dashboards should be unified |

---

## 5. Metrics aggregation strategy

| Layer | Storage | Use |
|-------|---------|-----|
| **Raw** | `session_telemetry_events` | Drill-down, new questions |
| **Per session** | `session_telemetry_summary` (computed at end or async) | Support UI, session report |
| **Daily / global** | `telemetry_daily_rollup` | Trends, “are we improving?” |
| **Low-cardinality SLIs** | Prometheus (or vendor) | Alerting, SLO dashboards |

**Windows:** 1–5 min for ops (optional; needs TSDB or Redis if high volume), **daily** for product trends, **per `git_sha` / `app_version`** for regression analysis.

**Cardinality rule:** High cardinality only in **events** (session id, turn). **Metrics** use bounded labels (region, model family, status class — not raw prompt text).

---

## 6. Dashboard architecture

| Tier | Audience | Content |
|------|----------|---------|
| **Ops / SRE** | On-call | Error rates, STT/TTS failure %, LiveKit disconnects, `/turn` 5xx, SLO panels |
| **Product / AI** | PM, AI owner | Probe rate, turns to close, interruption rate, fallback %, brain action mix |
| **Session detail** | Support / debug | Timeline of `session_telemetry_events` + link to transcript turns |

**Stack options:** Grafana (Prometheus + Loki/Tempo), hosted APM, or **v1:** internal dashboard pages backed by SQL views.

---

## 7. Realtime analytics recommendations

- **Single session live view:** SSE or lightweight WebSocket channel per `session_id` — push **aggregated** counters only, not every raw event.
- **Fleet “last 15 minutes”:** Redis counters or a time-series store; refresh aggregates on a short interval; do not heavy-scan Postgres on every event.
- **Pattern:** Write path = cheap append + increment; read path = precomputed rollups.

---

## 8. Event schema design

**Common envelope** (client and server):

```json
{
  "event_name": "interview.turn.brain.completed",
  "event_version": 1,
  "occurred_at": "2026-05-09T12:34:56.789Z",
  "ingest_source": "client",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": 12345,
  "job_id": 99,
  "turn_index": 7,
  "interview_state": "processing",
  "attrs": {
    "latency_ms": 842,
    "model": "gpt-4o",
    "action": "probe",
    "outcome": "ok"
  }
}
```

| Field | Notes |
|-------|--------|
| `event_version` | Increment when `attrs` contract changes |
| `trace_id` | Same id for one user-perceived “turn” across STT → turn → TTS |
| `attrs` | Flatten when possible; use stable enum strings |

---

## 9. Event naming conventions

- **Pattern:** `domain.component.qualifier` — use **dot-separated** names.
- **Verbs** for actions: `connected`, `completed`, `failed`, `disconnected`.
- **Stable `attrs` keys:** `snake_case` (`latency_ms`, `reason`, `eot_source`, `fallback_type`).
- **Examples:** `stt.assemblyai.connected`, `stt.final_latency`, `ai.brain.request`, `ai.brain.response`, `tts.openai.first_byte`, `livekit.room.disconnected`, `interview.eot.fused`, `interview.fallback.timer_fired`.

---

## 10. Tracking map (metrics → events)

| Goal | Event / metric |
|------|-----------------|
| Transcript latency | `stt.final_latency` — `attrs.latency_ms`, optionally breakdown in `attrs` |
| AI decision latency | `ai.brain.completed` — `attrs.duration_ms` (server authoritative) |
| Interruptions | `interview.vad.speech_started` with `attrs.during_maya_speech: true` or overlap flag |
| Pauses | `interview.listening.phase` with `phase: pause \| speaking` + durations |
| Probes | `ai.brain.response` with `attrs.action: probe` |
| STT failure | `stt.error` — `error_class`, `recoverable` |
| TTS failure | `tts.error` |
| LiveKit disconnect | `livekit.room.disconnected` — `reason`, `close_code` if applicable |
| Fallback | `interview.eot.fallback_used` — `fallback_type` |
| EOT quality | `interview.eot.decision` — `eot_source`, `confidence`, optional `fusion_match` |

---

## 11. Database table structure (PostgreSQL)

Implemented in **`db/migrations/010_telemetry.sql`** (uses UUID `session_id` / `job_id` to match core schema).

### A. Raw events

```sql
CREATE TABLE session_telemetry_events (
  id            BIGSERIAL PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name    TEXT NOT NULL,
  event_version SMALLINT NOT NULL DEFAULT 1,
  source        TEXT NOT NULL CHECK (source IN ('client', 'server')),
  trace_id      UUID,
  turn_index    INTEGER,
  attrs         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_ste_session_time ON session_telemetry_events (session_id, occurred_at DESC);
CREATE INDEX idx_ste_name_time ON session_telemetry_events (event_name, occurred_at DESC);
-- Optional: partial GIN for specific attrs keys only (avoid full-jsonb GIN until needed)
```

### B. Session rollup (end of session or async job)

```sql
CREATE TABLE session_telemetry_summary (
  session_id                 UUID PRIMARY KEY REFERENCES interview_sessions(id) ON DELETE CASCADE,
  computed_at                TIMESTAMPTZ NOT NULL,
  transcript_latency_p95_ms    INTEGER,
  brain_latency_p95_ms         INTEGER,
  tts_first_byte_p95_ms      INTEGER,
  eot_accuracy_rate           NUMERIC(5,4),
  probe_count                 INTEGER,
  interruption_count          INTEGER,
  total_pause_ms              BIGINT,
  stt_failure_count           INTEGER,
  tts_failure_count           INTEGER,
  livekit_disconnect_count    INTEGER,
  fallback_event_count        INTEGER,
  attrs                       JSONB DEFAULT '{}'::jsonb
);
```

### C. Daily aggregates

```sql
CREATE TABLE telemetry_daily_rollup (
  day           DATE NOT NULL,
  job_id        UUID REFERENCES jobs(id),
  metric_key    TEXT NOT NULL,
  metric_value  DOUBLE PRECISION NOT NULL,
  sample_count  BIGINT,
  PRIMARY KEY (day, job_id, metric_key)
);
```

### D. Release / deploy markers (improvement tracking)

```sql
CREATE TABLE telemetry_release_markers (
  id           SERIAL PRIMARY KEY,
  deployed_at  TIMESTAMPTZ NOT NULL,
  version      TEXT NOT NULL,
  git_sha      TEXT,
  notes        TEXT
);
```

Join daily rollups to `telemetry_release_markers` to visualize **metrics vs deploy**.

---

## 12. WebSocket monitoring

| Channel | Instrument | Alert on |
|---------|------------|----------|
| **AssemblyAI (STT)** | Open, first message, error, close code, reconnect attempt | Non-clean close, reconnect storm |
| **LiveKit** | Room connected, participant events, disconnect reason | Spikes in disconnect rate or join failures |

Emit: `duration_connected_ms`, `close_code`, `was_clean`, `error_class` in `attrs`.

---

## 13. Latency tracking (spans and SLIs)

**Anchor timestamps for one “turn” (conceptual):**

1. `t_audio_end` — EOT / VAD boundary (your fusion output).
2. `t_stt_final` — final transcript available.
3. `t_brain_start` / `t_brain_end` — `/turn` request.
4. `t_tts_first_byte` / `t_playback_start` — Maya audible.

**Derived metrics**

| Name | Formula |
|------|---------|
| Transcript latency | `t_stt_final - t_audio_end` |
| AI decision latency | `t_brain_end - t_brain_start` |
| User-perceived response | `t_playback_start - t_audio_end` (strong SLO candidate) |

Use **monotonic clocks** for deltas on the client; persist **server `occurred_at`** for reporting consistency.

---

## 14. AI behavior analytics

- **Aggregate:** Distribution of brain `action` values; probes per question/category; turns to completion; malformed JSON / retry rate.
- **End-of-turn accuracy:** Log `interview.eot.decision` with source and confidence. Long-term: human-labeled boundary quality → store in `session_telemetry_summary.eot_accuracy_rate`.
- **Heuristic without labels:** Rate of “candidate resumed speaking shortly after Maya started” (possible bad EOT).

---

## 15. Session-level vs system-wide vs improvement over time

| Scope | Where |
|-------|--------|
| **Session** | `session_telemetry_events` + `session_telemetry_summary` |
| **System / job** | `telemetry_daily_rollup` filtered by `job_id` (nullable = global) |
| **Over time** | Daily charts + `telemetry_release_markers` + optional `app_version` in `attrs` |

---

## 16. Implementation phases (incremental build)

Use this as a **roadmap**; complete phases in order unless you have an urgent vertical slice.

| Phase | Scope | Done when |
|-------|--------|-----------|
| **0 — Design lock** | Envelope, naming doc, `trace_id` propagated client ↔ `/turn` | Single test session produces correlated ids in logs |
| **1 — Ingest + raw storage** | Migration `session_telemetry_events`, `POST /api/telemetry/batch`, client batching | Events visible in DB for real interviews |
| **2 — Server hooks** | Emit from `/turn`, TTS helper, STT lifecycle, optional LiveKit wrapper | Server-sourced latencies and outcomes stored |
| **3 — Session summary** | Job at `session.end` or cron: fill `session_telemetry_summary` | Support can open session metrics |
| **4 — Dashboards v1** | SQL views + internal pages or Grafana | Ops + product can see p95 and error rates |
| **5 — Daily rollups + releases** | Populate `telemetry_daily_rollup`, maintain `telemetry_release_markers` | Trend charts with deploy lines |
| **6 — Observability hardening** | Prometheus + alerts; optional OpenTelemetry traces | SLO alerting on prod |

### Implementation in this repo

| Phase | Where |
|-------|--------|
| 0–2 | `trace_id` on `/turn` and client; `src/lib/telemetry/*`; `POST /api/sessions/[token]/telemetry`; `useSessionTelemetry` + `useInterview` + `/api/speak` |
| 3 | `computeAndUpsertSessionSummary` from `/api/sessions/[token]/end` |
| 4 | `/dashboard/telemetry` |
| 5 | `GET /api/cron/telemetry-daily` (Bearer or `?secret=` with `CRON_SECRET`) |
| 6 | `GET /api/metrics` (optional `METRICS_SCRAPE_SECRET` via `?token=`) — lightweight; use vendor APM for real SLOs on serverless |

**Env:** `CRON_SECRET` (daily rollup), `METRICS_SCRAPE_SECRET` (scrape endpoint), optional `NEXT_PUBLIC_APP_VERSION` (client `attrs`).

**Migrate:** apply `db/migrations/010_telemetry.sql`.

---

## 17. Dashboard widgets and chart recommendations

**Widgets (examples)**

- SLO: p95 “silence/EOT → Maya playback start” with error budget.
- STT: reconnects per session, final latency p50/p95, failure %.
- Brain/scorer: latency p95, JSON errors, action mix (ask / probe / close).
- TTS: time to first byte, error rate.
- Product: probes per interview, session duration distribution, completion rate.
- Infra: LiveKit disconnect rate; recording chunk upload failures (if applicable).

**Charts**

- Histograms for latency (avoid mean-only).
- Time series of daily p95 with **vertical deploy markers**.
- Stacked area for error mix (STT vs TTS vs API).
- Scatter: duration vs probe count (outlier sessions).

---

## 18. Performance and safety considerations

- **Batch** client events (time window 1–2 s or N events max).
- **Async ingest:** validate + queue; do not block the interview thread on telemetry flush.
- **Partition or archive** raw events by month at high volume.
- **Indexes:** Start with `(session_id, occurred_at)` and `(event_name, occurred_at)`; add GIN on `attrs` only for proven queries.
- **Sampling:** Consider sampling noisy debug events (e.g. partial transcripts) in production.
- **PII:** Do not store raw transcript text in telemetry tables; reference `transcript_turns` ids if needed.

---

## 19. Quick reference checklist

- [x] Event envelope + naming doc (`/telemetry` API validates `event_name`)  
- [x] `trace_id` across EOT → `/turn` → TTS (with `session_token` + `trace_id` on `/api/speak`)  
- [x] Raw table + indexes — `010_telemetry.sql`  
- [x] Batched ingest — `POST /api/sessions/[token]/telemetry` (max 50 events)  
- [x] Server: `/turn`, `/speak`; client: EOT, STT errors, LiveKit, state  
- [x] Session summary on interview end  
- [x] Daily rollup cron + `telemetry_release_markers` (insert via SQL)  
- [x] Dashboard `/dashboard/telemetry`  
- [ ] Alerts on SLO regressions (external to this repo)  
- [x] Client `attrs` include `app_version` — set `NEXT_PUBLIC_APP_VERSION` to override default  

---

## Document maintenance

- **When adding a new signal:** Update §10 tracking map, add enum values to §9, and extend `attrs` with `event_version` bump if breaking.  
- **When changing DB:** Keep §11 in sync with actual migrations under `db/migrations/` (or your migration path).  
- **Review cadence:** After each phase, validate that new charts match at least one **measurable** product or reliability goal.

---

*Last aligned with Screeno stack: Next.js 14, PostgreSQL, LiveKit, AssemblyAI STT, OpenAI TTS + GPT brain/scorer (`PROJECT-OVERVIEW.md`).*
