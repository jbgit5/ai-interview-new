"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Brain, Mic2, PauseCircle, ShieldAlert, Volume2 } from "lucide-react";
import type { TelemetryEventRow } from "@/lib/observability/types";
import { eventsToLatencyChartRows } from "@/lib/observability/live-derive";
import { EventsDataTable } from "./events-data-table";
import { SessionInterviewLogByMinute } from "./session-interview-log-by-minute";
import { SessionTimingInsights } from "./session-timing-insights";
import { SessionEventTimeline } from "./session-event-timeline";
import { LatencyMultiLineChart } from "./charts/latency-multi-line-chart";
import { BarComparisonChart } from "./charts/bar-comparison-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricCard } from "./metric-card";

type DetailResponse = {
  session: {
    id: string;
    candidate_name: string | null;
    status: string;
    job_title: string;
    started_at: string | null;
    completed_at: string | null;
  };
  summary: {
    brain_latency_p95_ms: number | null;
    transcript_latency_p95_ms: number | null;
    tts_first_byte_p95_ms: number | null;
    probe_count: number | null;
    interruption_count: number | null;
    total_pause_ms: number | null;
    stt_failure_count: number | null;
    tts_failure_count: number | null;
    livekit_disconnect_count: number | null;
    fallback_event_count: number | null;
  } | null;
  turns: { turns: number; avg_llm: number | null; p95_llm: number | null };
};

function fmtMs(n: number | null | undefined) {
  if (n == null) return "—";
  return `${Math.round(n)} ms`;
}

function fmtDur(ms: number | null | undefined) {
  if (ms == null) return "—";
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

type Props = { sessionId: string };

/** Session drill-down — rollup summary, charts, pause / interruption / probes, full event table */
export function SessionAnalyticsClient({ sessionId }: Props) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [events, setEvents] = useState<TelemetryEventRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [dRes, eRes] = await Promise.all([
          fetch(`/api/observability/sessions/${sessionId}/detail`),
          fetch(`/api/observability/sessions/${sessionId}/events`),
        ]);
        if (!dRes.ok) {
          setErr(dRes.status === 404 ? "Session not found." : "Could not load session.");
          return;
        }
        if (!eRes.ok) {
          setErr("Could not load events.");
          return;
        }
        const d = (await dRes.json()) as DetailResponse;
        const ej = (await eRes.json()) as { events?: TelemetryEventRow[] };
        if (!cancelled) {
          setDetail(d);
          setEvents(ej.events ?? []);
          setErr(null);
        }
      } catch {
        if (!cancelled) setErr("Network error.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (detail?.session.id !== sessionId) return;
    if (detail?.session.status !== "in_progress") return;
    let cancelled = false;
    async function poll() {
      try {
        const [dRes, eRes] = await Promise.all([
          fetch(`/api/observability/sessions/${sessionId}/detail`),
          fetch(`/api/observability/sessions/${sessionId}/events`),
        ]);
        if (!dRes.ok || !eRes.ok || cancelled) return;
        const d = (await dRes.json()) as DetailResponse;
        const ej = (await eRes.json()) as { events?: TelemetryEventRow[] };
        if (!cancelled) {
          setDetail(d);
          setEvents(ej.events ?? []);
        }
      } catch {
        /* ignore poll errors */
      }
    }
    const id = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, detail?.session.id, detail?.session.status]);

  const latencyRows = useMemo(() => eventsToLatencyChartRows(events), [events]);

  const interruptEvents = useMemo(
    () => events.filter((e) => e.event_name === "interview.vad.interruption"),
    [events]
  );

  const pauseSignals = useMemo(
    () => events.filter((e) => e.event_name.includes("pause") || e.event_name.includes("eot")),
    [events]
  );

  const probeRelated = useMemo(
    () =>
      events.filter(
        (e) =>
          e.event_name === "ai.brain.completed" &&
          String((e.attrs as { action?: string }).action) === "probe"
      ),
    [events]
  );

  const sttFallbacks = useMemo(
    () => events.filter((e) => e.event_name === "stt.fallback"),
    [events]
  );
  const sttDeepgramErrors = useMemo(
    () => events.filter((e) => e.event_name === "stt.deepgram.error"),
    [events]
  );

  if (err && !detail) {
    return <p className="text-rose-300">{err}</p>;
  }

  if (!detail) {
    return <p className="text-slate-500">Loading session…</p>;
  }

  const live = detail.session.status === "in_progress";
  const s = detail.session;
  const sum = detail.summary;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/dashboard/observability"
            className="mb-1 inline-flex items-center gap-1 text-sm text-violet-400 hover:text-violet-300"
          >
            <ArrowLeft className="h-4 w-4" />
            Observability
          </Link>
          <h2 className="text-2xl font-bold text-slate-50">{s.candidate_name ?? "Candidate"}</h2>
          <p className="text-slate-500">{s.job_title}</p>
        </div>
        <Badge variant="secondary" className="w-fit capitalize">
          {s.status.replace("_", " ")}
        </Badge>
      </div>

      {err && <p className="text-sm text-amber-200">{err}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Turns completed"
          value={detail.turns.turns}
          icon={Brain}
          live={live}
        />
        <MetricCard
          title="Brain p95 (session)"
          value={sum?.brain_latency_p95_ms != null ? fmtMs(sum.brain_latency_p95_ms) : "—"}
          subtitle="Rollup"
          icon={Brain}
        />
        <MetricCard
          title="STT p95"
          value={fmtMs(sum?.transcript_latency_p95_ms ?? null)}
          subtitle="Transcript path"
          icon={Mic2}
        />
        <MetricCard
          title="TTS p95"
          value={fmtMs(sum?.tts_first_byte_p95_ms ?? null)}
          subtitle="First byte"
          icon={Volume2}
        />
      </div>

      {(sttFallbacks.length > 0 || sttDeepgramErrors.length > 0) && (
        <Card className="border-amber-500/35 bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-100">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              Deepgram → Web Speech (this session)
            </CardTitle>
            <CardDescription>
              The interview can continue on browser speech recognition when Deepgram drops. These telemetry rows show{" "}
              <strong className="text-slate-300">why</strong> the handoff happened (close code, token error, timeout,
              etc.).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-slate-300">
              <span className="font-semibold text-slate-100">Fallback handoffs: </span>
              <span className="font-mono">{sttFallbacks.length}</span>
            </p>
            <p className="text-slate-300">
              <span className="font-semibold text-slate-100">Deepgram error events: </span>
              <span className="font-mono">{sttDeepgramErrors.length}</span>
            </p>
            <ul className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/50 p-3 font-mono text-xs text-slate-400">
              {sttFallbacks.map((e) => {
                const a = e.attrs as Record<string, string | undefined>;
                return (
                  <li key={e.id}>
                    <span className="text-amber-200/90">stt.fallback</span> · {a.stage ?? "?"} · code{" "}
                    {a.deepgram_code ?? "—"} · {(a.detail ?? "").slice(0, 200)}
                  </li>
                );
              })}
              {sttDeepgramErrors.map((e) => {
                const a = e.attrs as { detail?: string };
                return (
                  <li key={e.id}>
                    <span className="text-rose-300/90">stt.deepgram.error</span> · {(a.detail ?? "").slice(0, 220)}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="border-violet-500/20 bg-slate-900/40">
        <CardHeader>
          <CardTitle>Time & pacing (main insight)</CardTitle>
          <CardDescription>
            Where the interview burns wall-clock time, how painful Deepgram fallback was, and unexplained telemetry
            gaps — use this loop to tighten the{" "}
            <strong className="text-slate-300">Interview Room experience</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SessionTimingInsights events={events} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Interview log by minute</CardTitle>
          <CardDescription>
            Timeline of <strong className="text-slate-300">stored telemetry</strong> (state changes, STT, brain, TTS,
            fallbacks). In-room debug lines from the candidate UI are not uploaded unless we add a mirror event — this is
            the authoritative DB-backed story.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SessionInterviewLogByMinute events={events} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Latency mix</CardTitle>
            <CardDescription>Sequential STT / GPT / TTS samples from raw events</CardDescription>
          </CardHeader>
          <CardContent>
            {latencyRows.length === 0 ? (
              <p className="text-sm text-slate-500">No latency events recorded.</p>
            ) : (
              <LatencyMultiLineChart data={latencyRows} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-400" />
              Interruptions
            </CardTitle>
            <CardDescription>Rollup + live VAD events</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-slate-300">
              Summary count:{" "}
              <span className="font-mono text-slate-100">{sum?.interruption_count ?? "—"}</span>
            </p>
            <p className="text-slate-400">
              Telemetry rows: <span className="font-mono">{interruptEvents.length}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PauseCircle className="h-5 w-5 text-cyan-400" />
              Pause analysis
            </CardTitle>
            <CardDescription>Total paused time + pause-related markers</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-300">
            <p>
              Total pause (rollup):{" "}
              <span className="font-semibold text-slate-100">{fmtDur(sum?.total_pause_ms)}</span>
            </p>
            <p className="text-slate-500">
              Related events: {pauseSignals.length} (EOT / pause pipeline)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Probe history</CardTitle>
            <CardDescription>
              Rollup probe count + brain actions tagged <code className="text-xs">probe</code>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-slate-300">
              Summary probes:{" "}
              <span className="font-mono text-slate-100">{sum?.probe_count ?? "—"}</span>
            </p>
            <p className="text-slate-400">
              Probe turns (from events):{" "}
              <span className="font-mono">{probeRelated.length}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Full timeline</CardTitle>
          <CardDescription>Chronological density for this session</CardDescription>
        </CardHeader>
        <CardContent>
          <SessionEventTimeline events={events} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LLM latency (turn_metrics)</CardTitle>
          <CardDescription>Average vs p95 across recorded turns</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-xs uppercase text-slate-500">Avg LLM ms</p>
              <p className="text-2xl font-semibold">{fmtMs(detail.turns.avg_llm)}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <p className="text-xs uppercase text-slate-500">p95 LLM ms</p>
              <p className="text-2xl font-semibold">{fmtMs(detail.turns.p95_llm)}</p>
            </div>
          </div>
          {detail.turns.avg_llm != null && detail.turns.p95_llm != null ? (
            <BarComparisonChart
              data={[
                {
                  name: "LLM",
                  avg: detail.turns.avg_llm,
                  p95: detail.turns.p95_llm,
                },
              ]}
            />
          ) : (
            <p className="text-sm text-slate-500">Insufficient turn samples.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telemetry events</CardTitle>
          <CardDescription>Newest-first table (TanStack)</CardDescription>
        </CardHeader>
        <CardContent>
          <EventsDataTable events={events} />
        </CardContent>
      </Card>
    </div>
  );
}
