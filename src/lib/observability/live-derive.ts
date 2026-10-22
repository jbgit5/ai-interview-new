/**
 * Pure helpers: derive “live” UI state from raw telemetry rows (no backend changes).
 */
import type { LatencyChartRow, TelemetryEventRow } from "./types";

function num(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === "string" ? v : null;
}

export type LiveSnapshot = {
  interviewState: string | null;
  candidateLane: string;
  aiLane: string;
  deepgramMs: number | null;
  gptMs: number | null;
  ttsMs: number | null;
  lastTurnTotalMs: number | null;
  interruptionCount: number;
  probeTurnCount: number;
};

/** Sort ascending by time for deterministic timeline + latest-value scans. */
export function sortEventsAsc(events: TelemetryEventRow[]): TelemetryEventRow[] {
  return [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
}

/** Aggregate counters + latest latencies from a session event window. */
export function deriveLiveSnapshot(events: TelemetryEventRow[]): LiveSnapshot {
  const asc = sortEventsAsc(events);
  let state: string | null = null;
  let deepgramMs: number | null = null;
  let gptMs: number | null = null;
  let ttsMs: number | null = null;
  let lastTurnTotalMs: number | null = null;
  let interruptionCount = 0;
  let probeTurnCount = 0;

  for (const e of asc) {
    const a = e.attrs;
    if (e.event_name === "interview.state_change") {
      const to = str(a, "to");
      if (to) state = to;
    }
    if (e.event_name === "stt.final_latency") {
      const ms = num(a, "stt_final_latency_ms") ?? num(a, "latency_ms");
      if (ms != null) deepgramMs = ms;
    }
    if (e.event_name === "ai.brain.completed") {
      const lm = num(a, "llm_ms");
      const tm = num(a, "total_ms");
      if (lm != null) gptMs = lm;
      if (tm != null) lastTurnTotalMs = tm;
      if (str(a, "action") === "probe") probeTurnCount += 1;
    }
    if (e.event_name === "tts.openai.completed") {
      const tf = num(a, "tts_fetch_ms");
      if (tf != null) ttsMs = tf;
    }
    if (e.event_name === "interview.vad.interruption") interruptionCount += 1;
  }

  let candidateLane = "—";
  let aiLane = "—";
  switch (state) {
    case "listening":
      candidateLane = "Speaking (mic)";
      aiLane = "Listening";
      break;
    case "processing":
      candidateLane = "Waiting";
      aiLane = "Thinking (LLM)";
      break;
    case "speaking":
      candidateLane = "Listening";
      aiLane = "Voice output (TTS)";
      break;
    case "intro":
      candidateLane = "Setup";
      aiLane = "Opening";
      break;
    case "idle":
      candidateLane = "Idle";
      aiLane = "Idle";
      break;
    case "completed":
      candidateLane = "Done";
      aiLane = "Done";
      break;
    case "error":
      candidateLane = "Error";
      aiLane = "Error";
      break;
    default:
      if (state) {
        candidateLane = state;
        aiLane = state;
      }
  }

  return {
    interviewState: state,
    candidateLane,
    aiLane,
    deepgramMs,
    gptMs,
    ttsMs,
    lastTurnTotalMs,
    interruptionCount,
    probeTurnCount,
  };
}

export type LatencyPoint = { t: string; stt: number | null; llm: number | null; tts: number | null };

/** Build per-event latency samples for fine-grained charts. */
export function eventsToLatencySeries(events: TelemetryEventRow[]): LatencyPoint[] {
  const asc = sortEventsAsc(events);
  const out: LatencyPoint[] = [];
  for (const e of asc) {
    const a = e.attrs;
    const t = new Date(e.occurred_at).toISOString();
    if (e.event_name === "stt.final_latency") {
      const stt = num(a, "stt_final_latency_ms") ?? num(a, "latency_ms");
      out.push({ t, stt, llm: null, tts: null });
    } else if (e.event_name === "ai.brain.completed") {
      out.push({
        t,
        stt: null,
        llm: num(a, "llm_ms"),
        tts: null,
      });
    } else if (e.event_name === "tts.openai.completed") {
      out.push({ t, stt: null, llm: null, tts: num(a, "tts_fetch_ms") });
    }
  }
  return out;
}

/**
 * Sequential latency rows for Recharts — each step is one telemetry emission
 * (STT / brain / TTS), sparse columns use null so lines skip cleanly.
 */
export function eventsToLatencyChartRows(events: TelemetryEventRow[]): LatencyChartRow[] {
  const asc = sortEventsAsc(events);
  const rows: LatencyChartRow[] = [];
  let i = 0;
  for (const e of asc) {
    const a = e.attrs;
    if (e.event_name === "stt.final_latency") {
      const stt = num(a, "stt_final_latency_ms") ?? num(a, "latency_ms");
      if (stt != null) {
        rows.push({
          label: `#${++i}`,
          stt,
          llm: null,
          tts: null,
        });
      }
    } else if (e.event_name === "ai.brain.completed") {
      const lm = num(a, "llm_ms");
      if (lm != null) rows.push({ label: `#${++i}`, stt: null, llm: lm, tts: null });
    } else if (e.event_name === "tts.openai.completed") {
      const tf = num(a, "tts_fetch_ms");
      if (tf != null) rows.push({ label: `#${++i}`, stt: null, llm: null, tts: tf });
    }
  }
  return rows;
}
