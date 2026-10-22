"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TelemetryEventRow } from "@/lib/observability/types";
import {
  buildPhaseTimeline,
  largeGapsBetweenEvents,
  pairFallbackRecoveries,
  summarizeSlowPhases,
} from "@/lib/observability/session-timing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function secs(ms: number) {
  return `${(ms / 1000).toFixed(ms >= 60_000 ? 1 : 2)} s`;
}

type Props = { events: TelemetryEventRow[] };

/**
 * Answers: Where did we burn time phase-by-phase? Was fallback slow? Were there unexplained stalls?
 */
export function SessionTimingInsights({ events }: Props) {
  const phases = buildPhaseTimeline(events);
  const { slowCount, maxDwellMs, slowPhases } = summarizeSlowPhases(phases, 35_000);
  const gaps = largeGapsBetweenEvents(events).slice(-20);
  const fallbacks = pairFallbackRecoveries(events);

  /** Cap chart rows for readability (last N transitions) */
  const chartTail = phases.slice(-24).map((p) => ({
    label: `${p.phaseThatEnded}→${p.entered} (#${p.ix})`,
    seconds: +(p.dwellMsInPhaseThatEnded / 1000).toFixed(2),
    dwellMs: p.dwellMsInPhaseThatEnded,
    elapsed: p.interviewElapsedWallMsAtTransition,
  }));

  const avgProcessing =
    phases.filter((p) => p.phaseThatEnded === "processing").length === 0
      ? null
      : phases
          .filter((p) => p.phaseThatEnded === "processing")
          .reduce((a, p) => a + p.dwellMsInPhaseThatEnded, 0) /
        phases.filter((p) => p.phaseThatEnded === "processing").length;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Slowest phase dwell
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-50">{secs(maxDwellMs)}</p>
          <p className="mt-1 text-xs text-slate-500">
            Largest time spent in any single UI state between transitions
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Long listens (&gt;=35 s)
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-amber-200">{slowCount}</p>
          <p className="mt-1 text-xs text-slate-500">How often candidates stayed unusually long in one state</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Avg “processing” stay
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-violet-200">
            {avgProcessing != null ? secs(avgProcessing) : "—"}
          </p>
          <p className="mt-1 text-xs text-slate-500">Rough brain+write wait per answering cycle</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Phase dwell timeline (last transitions)</CardTitle>
          <CardDescription>
            Each bar is{" "}
            <code className="text-xs text-slate-400">duration_in_previous_state_ms</code> emitted with{" "}
            <code className="text-xs text-slate-400">interview.state_change</code> — use it to see where pacing
            drags (long listening blocks, sluggish processing, oversized TTS, etc.).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {chartTail.length === 0 ? (
            <p className="text-sm text-slate-500">
              No state-change durations yet — complete a session on client build ≥ this instrumentation pass.
            </p>
          ) : (
            <div
              className="w-full min-h-[260px]"
              style={{ height: Math.min(520, Math.max(220, chartTail.length * 24)) }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={chartTail}
                  margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={{ stroke: "#334155" }}
                    tickFormatter={(v) => `${v}s`}
                  />
                  <YAxis
                    width={148}
                    type="category"
                    dataKey="label"
                    tick={{ fill: "#64748b", fontSize: 9 }}
                    axisLine={{ stroke: "#334155" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#0f172a",
                      border: "1px solid #334155",
                      borderRadius: "10px",
                      fontSize: "12px",
                    }}
                    formatter={(value: unknown) => {
                      const v = typeof value === "number" ? value : Number(value);
                      return [`bar height ≈ ${Number.isFinite(v) ? `${v}s` : value}`, ""];
                    }}
                  />
                  <Bar dataKey="seconds" name="dwell (s)" fill="#7c3aed" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Fallback → first Web Speech hypothesis</CardTitle>
            <CardDescription>
              Low values mean the mic path recovered quickly after Deepgram dropped. Large values imply dead air /
              degraded candidate experience — investigate VPN, FortiClient, or mic permissions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {fallbacks.length === 0 ? (
              <p className="text-slate-500">No Deepgram fallback rows in this session.</p>
            ) : (
              <ul className="space-y-2 font-mono text-xs text-slate-400">
                {fallbacks.map((f, i) => (
                  <li key={i} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                    <span className="text-slate-500">{new Date(f.fallbackAtIso).toLocaleTimeString()}</span>{" "}
                    <Badge variant="secondary" className="mx-1">
                      {f.stage ?? "?"}
                    </Badge>
                    {f.msUntilBrowserFirstHypothesis != null ? (
                      <span className="text-emerald-300">
                        → first hypothesis after {secs(f.msUntilBrowserFirstHypothesis)}
                      </span>
                    ) : (
                      <span className="text-amber-400">→ no matching stt.fallback.ready yet</span>
                    )}
                    {f.detail && <p className="mt-1 text-slate-500">{f.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stale gaps between telemetry points</CardTitle>
            <CardDescription>
              When two stored events arrive &gt;15 s apart — often network loss, suspended tab, or missing
              instrumentation (sparse events make gaps look worse).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {gaps.length === 0 ? (
              <p className="text-sm text-slate-500">
                No &gt;=15 s gaps detected between consecutive telemetry rows.
              </p>
            ) : (
              <ul className="max-h-72 space-y-2 overflow-y-auto font-mono text-xs">
                {gaps.map((g, i) => (
                  <li
                    key={i}
                    className={`rounded-md border px-2 py-1.5 ${g.severity === "slow" ? "border-rose-500/40 bg-rose-950/20" : "border-amber-500/30 bg-amber-950/15"}`}
                  >
                    <span className="text-slate-500">{secs(g.gapMs)} stall</span>{" "}
                    <span className="text-slate-600">after</span>{" "}
                    <span className="text-violet-300">{g.beforeEvent}</span>{" "}
                    <span className="text-slate-600">→ before</span>{" "}
                    <span className="text-violet-300">{g.afterEvent}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {slowPhases.length > 0 && (
        <Card className="border-amber-500/25 bg-amber-950/15">
          <CardHeader>
            <CardTitle>Longest stretches (inspect)</CardTitle>
            <CardDescription>Transitions where candidates sat in one state ≥35 s before the next phase.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 font-mono text-xs text-slate-400">
              {slowPhases.map((s) => (
                <li key={s.ix}>
                  {s.phaseThatEnded} lasted {secs(s.dwellMsInPhaseThatEnded)} before → {s.entered}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
