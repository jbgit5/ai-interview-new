"use client";

import { motion } from "framer-motion";
import type { TelemetryEventRow } from "@/lib/observability/types";
import { Badge } from "@/components/ui/badge";

/** Bucket ISO timestamps to UTC minute key for consistent grouping */
function utcMinuteKey(iso: string): string {
  return iso.slice(0, 16);
}

/** Human label for minute bucket */
function minuteLabelUtc(key: string): string {
  if (key.length < 16) return key;
  return `${key.slice(11, 16)} UTC · ${key.slice(0, 10)}`;
}

function headline(ev: TelemetryEventRow): string {
  const name = ev.event_name;
  if (name === "stt.fallback") {
    const a = ev.attrs as Record<string, string | undefined>;
    return `${a.from ?? "?"}→${a.to ?? "?"} · ${a.stage ?? ""} ${a.detail ? `— ${String(a.detail).slice(0, 120)}` : ""}`;
  }
  if (name === "stt.fallback.ready") {
    const a = ev.attrs as { ms_until_first_transcript_hypothesis?: number };
    const ms = a.ms_until_first_transcript_hypothesis;
    return ms != null ? `Browser hypothesis after ${Math.round(ms)} ms post-fallback` : "Web Speech hypotheses flowing";
  }
  if (name === "stt.deepgram.error") {
    const a = ev.attrs as { detail?: string };
    return `Deepgram error — ${(a.detail ?? "").slice(0, 120)}`;
  }
  if (name === "interview.state_change") {
    const a = ev.attrs as {
      from?: string;
      to?: string;
      duration_in_previous_state_ms?: number;
      interview_elapsed_ms_at_transition?: number;
    };
    const dur =
      typeof a.duration_in_previous_state_ms === "number"
        ? ` (${(a.duration_in_previous_state_ms / 1000).toFixed(1)} s in “${a.from ?? "?"}”)`
        : "";
    const el =
      typeof a.interview_elapsed_ms_at_transition === "number"
        ? ` · +${Math.round(a.interview_elapsed_ms_at_transition / 1000)} s since start`
        : "";
    return `State ${a.from ?? "?"} → ${a.to ?? "?"}${dur}${el}`;
  }
  if (name === "ai.brain.completed") {
    const a = ev.attrs as { action?: string };
    return `Brain done · action=${a.action ?? "?"}`;
  }
  return name;
}

type Props = { events: TelemetryEventRow[] };

/**
 * “What happened each minute” — groups stored telemetry (not the in-room dev log).
 * In-room `addLog` lines are still client-only unless we mirror them to telemetry later.
 */
export function SessionInterviewLogByMinute({ events }: Props) {
  const asc = [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime()
  );

  const buckets = new Map<string, TelemetryEventRow[]>();
  for (const e of asc) {
    const k = utcMinuteKey(e.occurred_at);
    const cur = buckets.get(k) ?? [];
    cur.push(e);
    buckets.set(k, cur);
  }

  const keys = Array.from(buckets.keys()).sort();

  if (keys.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No telemetry rows for this session yet (or session predates instrumentation).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {keys.map((key, idx) => {
        const row = buckets.get(key)!;
        const sttFb = row.filter((e) => e.event_name === "stt.fallback");
        const errs = row.filter((e) => e.event_name === "stt.deepgram.error" || e.event_name === "stt.error");
        return (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.02 }}
            className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-slate-200">{minuteLabelUtc(key)}</span>
              <Badge variant="secondary">{row.length} events</Badge>
              {sttFb.length > 0 && (
                <Badge variant="warning">Deepgram→WebSpeech ×{sttFb.length}</Badge>
              )}
              {errs.length > 0 && <Badge variant="outline">STT issue ×{errs.length}</Badge>}
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-slate-400">
              {row.map((e) => (
                <li key={e.id} className="font-mono">
                  <span className="text-slate-600">
                    {new Date(e.occurred_at).toISOString().slice(17, 23)}
                  </span>{" "}
                  <span className="text-violet-300">{e.event_name}</span>{" "}
                  <span className="text-slate-400">{headline(e)}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        );
      })}
    </div>
  );
}
