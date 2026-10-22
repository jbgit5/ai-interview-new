/**
 * Derived interview timing views for dashboards (pure functions on telemetry rows).
 */
import type { TelemetryEventRow } from "./types";

function sortAsc(events: TelemetryEventRow[]): TelemetryEventRow[] {
  return [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );
}

function num(attrs: Record<string, unknown>, k: string): number | undefined {
  const v = attrs[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** One exported row per detected interview.state_change (phase dwell time) */
export type PhaseTimelineRow = {
  ix: number;
  /** InterviewState that JUST ended (`from` attrs) */
  phaseThatEnded: string;
  entered: string;
  dwellMsInPhaseThatEnded: number;
  /** Monotonic-ish client wall ms since leaving idle — from telemetry attrs when present */
  interviewElapsedWallMsAtTransition?: number;
  transitionedAtIso: string;
};

export function buildPhaseTimeline(events: TelemetryEventRow[]): PhaseTimelineRow[] {
  const asc = sortAsc(events);
  const out: PhaseTimelineRow[] = [];
  let ix = 0;
  for (const e of asc) {
    if (e.event_name !== "interview.state_change") continue;
    const a = e.attrs as Record<string, unknown>;
    const from = typeof a.from === "string" ? a.from : "?";
    const to = typeof a.to === "string" ? a.to : "?";
    const dwell = num(a, "duration_in_previous_state_ms");
    const elapsed = num(a, "interview_elapsed_ms_at_transition");
    if (typeof dwell !== "number" || !Number.isFinite(dwell)) continue;
    out.push({
      ix: ix++,
      phaseThatEnded: from,
      entered: to,
      dwellMsInPhaseThatEnded: Math.round(dwell),
      ...(elapsed != null && Number.isFinite(elapsed)
        ? { interviewElapsedWallMsAtTransition: Math.round(elapsed) }
        : {}),
      transitionedAtIso: e.occurred_at,
    });
  }
  return out;
}

export type TelemetryGapWarning = {
  gapMs: number;
  beforeEvent: string;
  afterEvent: string;
  afterAtIso: string;
  severity: "attention" | "slow";
};

const GAP_SLOW_MS = 15_000;
const GAP_STALE_MS = 60_000;

/** Large wall-clock gaps between consecutive stored events → possible stall / stall / offline */
export function largeGapsBetweenEvents(events: TelemetryEventRow[]): TelemetryGapWarning[] {
  const asc = sortAsc(events);
  const out: TelemetryGapWarning[] = [];
  for (let j = 1; j < asc.length; j++) {
    const t0 = new Date(asc[j - 1].occurred_at).getTime();
    const t1 = new Date(asc[j].occurred_at).getTime();
    const diff = t1 - t0;
    if (diff < GAP_SLOW_MS) continue;
    out.push({
      gapMs: diff,
      beforeEvent: asc[j - 1].event_name,
      afterEvent: asc[j].event_name,
      afterAtIso: asc[j].occurred_at,
      severity: diff >= GAP_STALE_MS ? "slow" : "attention",
    });
  }
  return out;
}

export type FallbackPairView = {
  fallbackAtIso: string;
  stage?: string;
  detail?: string;
  msUntilBrowserFirstHypothesis?: number;
  hypothesisAtIso?: string;
};

/**
 * Join each `stt.fallback` with the next `stt.fallback.ready` in time order —
 * exposes how long fallback took before microphone produced any hypothesis.
 */
export function pairFallbackRecoveries(events: TelemetryEventRow[]): FallbackPairView[] {
  const asc = sortAsc(events);
  const out: FallbackPairView[] = [];
  let pendingFallback: TelemetryEventRow | null = null;

  for (const e of asc) {
    if (e.event_name === "stt.fallback") {
      if (pendingFallback) {
        out.push({
          fallbackAtIso: pendingFallback.occurred_at,
          ...attrsFallback(pendingFallback.attrs as Record<string, unknown>),
          msUntilBrowserFirstHypothesis: undefined,
          hypothesisAtIso: undefined,
        });
      }
      pendingFallback = e;
      continue;
    }
    if (e.event_name === "stt.fallback.ready" && pendingFallback) {
      const a = e.attrs as Record<string, unknown>;
      const ms = num(a, "ms_until_first_transcript_hypothesis");
      out.push({
        fallbackAtIso: pendingFallback.occurred_at,
        ...attrsFallback(pendingFallback.attrs as Record<string, unknown>),
        msUntilBrowserFirstHypothesis:
          typeof ms === "number" ? Math.round(ms) : undefined,
        hypothesisAtIso: e.occurred_at,
      });
      pendingFallback = null;
    }
  }

  if (pendingFallback) {
    out.push({
      fallbackAtIso: pendingFallback.occurred_at,
      ...attrsFallback(pendingFallback.attrs as Record<string, unknown>),
    });
  }

  return out;
}

function attrsFallback(attrs: Record<string, unknown>) {
  const stage = typeof attrs.stage === "string" ? attrs.stage : undefined;
  const detail = typeof attrs.detail === "string" ? attrs.detail.slice(0, 180) : undefined;
  return { stage, detail };
}

export function summarizeSlowPhases(rows: PhaseTimelineRow[], dwellWarnMs = 45_000) {
  const slow = rows.filter((r) => r.dwellMsInPhaseThatEnded >= dwellWarnMs);
  const max = rows.length
    ? Math.max(...rows.map((r) => r.dwellMsInPhaseThatEnded))
    : 0;
  return { slowCount: slow.length, maxDwellMs: max, slowPhases: slow.slice(-12) };
}
