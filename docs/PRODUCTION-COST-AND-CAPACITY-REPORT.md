# Production cost, capacity & realtime validation report

**Scope:** Current implementation in this repo only (no future enterprise architecture).  
**Pricing/limit sources (consulted 2026-05-11):** [LiveKit pricing](https://livekit.io/pricing), [Deepgram pricing](https://deepgram.com/pricing), [OpenAI pricing](https://platform.openai.com/docs/pricing).  
**Account-specific limits** (OpenAI RPM/TPM, exact LiveKit project tier) must be confirmed in each vendor dashboard.

---

## Executive summary (short answers)

### How much does one complete interview cost (vendor APIs, typical flow)?

**There is no single fixed dollar amount** — cost mixes **clock time** (LiveKit + Deepgram while audio streams) with **turn count** (each candidate answer triggers **two** OpenAI chat calls: `gpt-4o` + `gpt-4o-mini`, plus TTS per Maya utterance, plus a **summary** `gpt-4o` call at end).

**Practical ballpark for one finished screening interview**

| Component | Typical influence |
|-----------|-------------------|
| **Deepgram** (`nova-3` streaming @ **$0.0048/min**) | Often **largest** line item if the mic/STT stream is open most of the session. Example: **30 min** wall clock, ~**85%** of time streaming → ~**$0.12** (25.5 min × $0.0048). Upper bound if stream open 100% of wall clock: **30 min → ~$0.14**. |
| **LiveKit WebRTC** | Billed as **participant‑minutes** on your plan (included allowance vs overage **~$0.0005/min** on Ship overage example). **1 candidate × session length** ≈ one publisher’s minutes. Can be **$0** if inside monthly included minutes. |
| **OpenAI chat** (`gpt-4o` + `gpt-4o-mini`) | Scales with **answers and prompt size** (full system prompt + history every turn), **not** linearly with clock time. Many sessions fall in **~$0.04–$0.15** for chat for a normal-length interview; long job descriptions + many turns push higher. |
| **OpenAI TTS** (`tts-1`, **~$15 / 1M characters**) | Scales with **total characters** Maya speaks. Often **~$0.02–$0.08** per completed interview unless many long probes. |

**Single-number TL;DR (order of magnitude):** a **completed** screening interview often lands around **~$0.20–$0.50** in **third‑party API** spend for a **~25–35 minute** session with moderate dialogue — **higher** if the job description is huge (re‑sent on every `gpt-4o` turn) or the candidate runs the clock with the STT stream open. **Lower** (~**$0.08–$0.20**) for shorter sessions and fewer turns.

*Hosting (Vercel/VM), Postgres, disk for recordings, and bandwidth are extra and not included in those API figures.*

### How many parallel interviews can happen?

**Published vendor ceilings (theoretical)**

| Gate | Published figure | Notes |
|------|------------------|--------|
| **LiveKit Cloud — concurrent connections** | **100** on **Build**, **1,000** on **Ship**, **5,000** on **Scale** | One browser session ≈ **one connection** in the usual “single candidate in room” pattern. **100 parallel on Build = at the limit, no headroom.** |
| **Deepgram — WSS (streaming) concurrency** | **150** Pay As You Go, **225** Growth | **100** concurrent streams is **within** 150 if each interview has one stream. |
| **OpenAI** | **Tier-specific** (RPM/TPM) | Must read **Organization → Limits** in OpenAI; each `/turn` does **2** chat completions in parallel. |
| **This app — PostgreSQL pool** | Default **`DATABASE_POOL_SIZE` = 20** in `src/lib/db.ts` | `/api/sessions/[token]/turn` holds a pool client for the **whole** request including LLM latency. **~20 concurrent `/turn` calls can exhaust the pool** even if vendors allow more. |

**Practical answer**

- **Without infra changes:** treat **~15–25** simultaneous “heavy” interviews (overlapping `/turn` + DB work) as a **safer** starting point than 100, unless you **raise** `DATABASE_POOL_SIZE` and Postgres `max_connections` and prove headroom with load tests.
- **For a clean 100‑way parallel test:** you likely need **LiveKit above Build** (for **connection headroom** and included minutes), **higher OpenAI tier**, and **DB pool + Postgres** tuned for burst concurrency — then validate with staged k6 + real WebRTC soak.

---

## 1. Implementation truth (what the code actually uses)

### OpenAI — not “Realtime API”

The product uses:

- **`openai.chat.completions.create`** — `gpt-4o` (opening + brain JSON), `gpt-4o-mini` (scoring JSON in parallel per answer).
- **`openai.audio.speech.create`** — **`tts-1`**, voice **`nova`**, via **`POST /api/speak`**.

There is **no** OpenAI **Realtime API** usage in the interview loop.

**References:** `src/app/api/sessions/[token]/turn/route.ts`, `src/app/api/speak/route.ts`.

### STT — Deepgram (not AssemblyAI in production path)

- **`@deepgram/sdk`** `listen.live`, model **`nova-3`**, `language: "en-US"`.

**Reference:** `src/hooks/useSpeechCapture.ts`.

### LiveKit

- Client publishes **1280×720 @ 24fps** video + audio.
- Access token TTL **2h**.

**References:** `src/hooks/useLiveKit.ts`, `src/app/api/livekit/token/route.ts`.

### Control plane to your server

- **`/turn`**, **`/speak`**, **`/telemetry`** are **HTTPS** (telemetry batched in `useSessionTelemetry`).
- **WebSocket** to **Deepgram** from the browser for STT.

---

## 2. Official unit pricing (relevant SKUs)

| Service | SKU / model | Rate (public docs) |
|-----------|-------------|-------------------|
| Deepgram | `nova-3` monolingual **streaming** | **$0.0048 / audio minute** (Pay As You Go) |
| OpenAI | `gpt-4o` (Standard) | **$2.50 / 1M input tokens**, **$10 / 1M output tokens** |
| OpenAI | `gpt-4o-mini` (Standard) | **$0.15 / 1M input**, **$0.60 / 1M output** |
| OpenAI | `tts-1` | **$15 / 1M characters** (standard TTS‑1 rate; align with OpenAI audio pricing table) |
| LiveKit | WebRTC participant minutes | **Plan allowances**; overage example on Ship tier docs **~$0.0005 / minute** after included pool |
| LiveKit | Downstream data | **50 GB (Build)** / **250 GB + $0.12/GB (Ship)** / **3 TB + $0.10/GB (Scale)** — matters if many subscribers or high fanout |

**Internal rollup note:** `src/app/api/sessions/[token]/end/route.ts` aggregates `turn_metrics` and uses a **simplified blended** rate for `gpt-4o-mini`; for finance-grade accuracy, split **mini input vs output** using `usage` fields the same way as `gpt-4o`.

---

## 3. Cost methodology

### Time-metered

- **Deepgram:** audio minutes while the live stream is open (≤ wall time; often a large fraction of wall time).
- **LiveKit:** participant‑minutes ≈ **one publisher × connected time** (reconnects add time).

### Turn-metered (dominant for LLM)

- **Opening:** one `gpt-4o` call, `max_tokens` 200.
- **Each candidate answer:** parallel **`gpt-4o`** (`max_tokens` 400) + **`gpt-4o-mini`** (`max_tokens` 300).
- **End:** one `gpt-4o` summary, `max_tokens` 800.
- **`MAX_TURNS = 10`** caps progression — LLM cost has an **upper bound per interview**, not unlimited growth with a long silent candidate.

### TTS-metered

- One **`/api/speak`** per Maya utterance; billed on **input characters**.

### Worked examples (time-only slice)

Deepgram upper bound (**stream open 100%** of wall clock), LiveKit overage at **$0.0005/min**, **1** publisher:

| Wall duration | Deepgram (upper) | LiveKit overage ex. | Subtotal (STT + LK only) |
|---------------|------------------|---------------------|---------------------------|
| 10 min | ~$0.048 | ~$0.005 | ~$0.053 |
| 20 min | ~$0.096 | ~$0.010 | ~$0.106 |
| 30 min | ~$0.144 | ~$0.015 | ~$0.159 |
| 45 min | ~$0.216 | ~$0.023 | ~$0.239 |
| 60 min | ~$0.288 | ~$0.030 | ~$0.318 |

Add OpenAI chat + TTS from **`turn_metrics`** + interviewer character totals per session for session-specific totals.

---

## 4. Subscription & limit summary

### LiveKit ([pricing](https://livekit.io/pricing))

| Plan | WebRTC min / mo (included) | Concurrent connections | Downstream included |
|------|----------------------------|------------------------|---------------------|
| Build | 5,000 | **100** | 50 GB |
| Ship | 150,000 | **1,000** | 250 GB → then per GB |
| Scale | 1.5M | **5,000** | 3 TB → then per GB |

This app uses **WebRTC participants**, not LiveKit Cloud “Agents” for LLM/STT.

### Deepgram ([pricing](https://deepgram.com/pricing))

- Streaming **nova-3** monolingual: **$0.0048/min**.
- Published **WSS** STT concurrency: **150** (PAYG), **225** (Growth).

### OpenAI ([pricing](https://platform.openai.com/docs/pricing))

- **RPM/TPM:** **account tier** — check dashboard + `x-ratelimit-*` headers under load.
- Burst pattern: **2×** chat completions per `/turn`.

### This application

- **`DATABASE_POOL_SIZE`** default **20** (`src/lib/db.ts`) — likely **first bottleneck** under concurrent `/turn` if not raised.
- **`scripts/load-test.js`** stresses **HTTP** APIs; it does **not** replace a **WebRTC** soak.

---

## 5. LiveKit infrastructure (behavioral)

- **Audio-only vs audio+video:** code publishes **both**; audio-only would reduce uplink/downstream but is **not** current behavior.
- **Adaptive:** `Room` uses `adaptiveStream: true`, `dynacast: true`.
- **Reconnect:** `ConnectionState.Reconnecting` telemetry in `useLiveKit.ts`.
- **Latency:** measure with LiveKit client stats + your DB telemetry; real-world TURN/corporate networks add jitter.

---

## 6. Load testing strategy (practical)

| Stage | Purpose |
|-------|---------|
| 10 / 25 / 50 / 100 | Staged ramp; watch **429**, **5xx**, **DB pool timeouts**, **p95 `/turn`**. |
| k6 | HTTP `/start`, `/turn`, `/speak` (see `scripts/load-test.js`). |
| Browser farm | **Playwright** (or similar) for true **WebRTC + Deepgram** path. |
| STT stress | Optional k6 WebSocket or Node harness with `@deepgram/sdk` mirroring prod. |

---

## 7. Latency monitoring (SLI suggestions)

Use existing telemetry patterns in `docs/OBSERVABILITY.md` and server events (`tts.openai.completed`, `ai.brain.completed`, LiveKit connect/reconnect).

| Segment | Good (indicative) | Warning | Critical |
|---------|-------------------|---------|----------|
| STT stable after speech end | <300–600 ms | 600–1200 ms | >1500 ms / frequent fallback |
| `/turn` p95 | <2 s | 2–4 s | >5 s / errors |
| TTS fetch | <700 ms | 700–1500 ms | near **15s** timeout (`/api/speak`) |
| E2E candidate stop → Maya audio | <1.2 s | 1.2–2.5 s | >3 s sustained |

Tune from your own histograms (`turn_metrics`, telemetry tables).

---

## 8. Risk assessment (100 concurrent)

| Risk | Cause |
|------|--------|
| LiveKit join failures / limit | **Build = 100** concurrent connections (no headroom) |
| OpenAI 429 | Low tier vs **2×** chat per `/turn` burst |
| Deepgram errors / limit | Rare at 100 if **one** stream each and PAYG **150** WSS |
| DB timeouts / tail latency | **`pool.connect()`** held across LLM in `/turn`, **pool default 20** |
| TTS failures | Upstream slowness vs **15s** abort |

**Most likely to fail first under naive 100-way test:** **Postgres pool** and/or **OpenAI rate limits**, with **LiveKit Build** exactly at published **100** connection cap.

---

## 9. Production readiness checklist (before 100 parallel)

1. Confirm **LiveKit** plan: **concurrent connections** and **WebRTC minutes** vs test burn.
2. Confirm **OpenAI** org **limits** for burst `/turn` traffic.
3. Confirm **Deepgram** credits + **WSS** concurrency (include non-prod usage).
4. Set **`DATABASE_POOL_SIZE`** and Postgres **`max_connections`** for expected concurrent `/turn` overlap; load-test until stable.
5. Run **staged** k6, then **smaller** real WebRTC cohort, then scale.
6. Optionally align internal docs: `docs/SCALE-READINESS.md` still references **AssemblyAI** in places — production STT path is **Deepgram**.

---

## 10. Code references (quick index)

| Topic | Location |
|-------|----------|
| Turn / models / `MAX_TURNS` | `src/app/api/sessions/[token]/turn/route.ts` |
| TTS | `src/app/api/speak/route.ts` |
| End summary + cost rollup | `src/app/api/sessions/[token]/end/route.ts` |
| Deepgram live | `src/hooks/useSpeechCapture.ts` |
| LiveKit publish + room options | `src/hooks/useLiveKit.ts` |
| LiveKit token TTL | `src/app/api/livekit/token/route.ts` |
| DB pool size | `src/lib/db.ts` |
| HTTP load test | `scripts/load-test.js` |
| Telemetry | `docs/OBSERVABILITY.md`, `src/hooks/useSessionTelemetry.ts` |

---

*This document is engineering guidance based on public vendor pricing and this repository’s code paths; it is not legal or financial advice.*
