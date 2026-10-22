"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, Brain, Mic, Waves } from "lucide-react";
import type { SessionListItem, TelemetryEventRow } from "@/lib/observability/types";
import { deriveLiveSnapshot, sortEventsAsc } from "@/lib/observability/live-derive";
import { LivePulse } from "./live-pulse";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionEventTimeline } from "./session-event-timeline";
import { motion, AnimatePresence } from "framer-motion";

function fmtMs(n: number | null) {
  if (n == null) return "—";
  return `${Math.round(n)} ms`;
}

function stateVariant(s: string | null): "default" | "secondary" | "success" | "warning" | "outline" {
  if (!s) return "secondary";
  if (s === "listening") return "success";
  if (s === "processing") return "warning";
  if (s === "speaking") return "default";
  if (s === "completed") return "secondary";
  if (s === "error") return "outline";
  return "outline";
}

/** Pick a session, poll events, render live lanes + animated feed */
export function LiveSessionMonitor() {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [events, setEvents] = useState<TelemetryEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetch("/api/observability/sessions?limit=60");
      if (!r.ok) return;
      const j = await r.json();
      if (cancelled) return;
      const list: SessionListItem[] = j.sessions ?? [];
      setSessions(list);
      const firstInProgress = list.find((s) => s.status === "in_progress");
      if (firstInProgress) setSessionId(firstInProgress.session_id);
      else if (list[0]) setSessionId(list[0].session_id);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    async function tick() {
      const r = await fetch(`/api/observability/sessions/${sessionId}/events`);
      if (!r.ok || cancelled) return;
      const j = (await r.json()) as { events?: TelemetryEventRow[] };
      setEvents(j.events ?? []);
    }
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId]);

  const snap = useMemo(() => deriveLiveSnapshot(events), [events]);
  const asc = useMemo(() => sortEventsAsc(events), [events]);
  const feed = useMemo(() => [...asc].reverse().slice(0, 20), [asc]);

  const selected = sessions.find((s) => s.session_id === sessionId);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-slate-500">Select a session to observe telemetry as it arrives.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LivePulse label={`Polling ${sessionId ? "2s" : "—"}`} active={!!sessionId} />
          <select
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            disabled={loading}
          >
            {sessions.length === 0 && <option value="">No sessions</option>}
            {sessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {(s.candidate_name ?? "Candidate") + " — " + s.job_title.slice(0, 40)}
                {s.status === "in_progress" ? " (live)" : ""}
              </option>
            ))}
          </select>
          {sessionId && (
            <Link
              href={`/dashboard/observability/sessions/${sessionId}`}
              className="rounded-xl bg-violet-600/20 px-3 py-2 text-sm text-violet-200 hover:bg-violet-600/30"
            >
              Open analytics
            </Link>
          )}
        </div>
      </div>

      {!sessionId && !loading && (
        <p className="text-slate-500">No sessions available for this recruiter.</p>
      )}

      {sessionId && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-emerald-400" />
                  Interview state
                </CardTitle>
                <CardDescription>Derived from latest interview.state_change telemetry</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-slate-500">State</span>
                  <Badge variant={stateVariant(snap.interviewState)}>
                    {snap.interviewState ?? "unknown"}
                  </Badge>
                  {selected && (
                    <Badge variant="outline" className="capitalize">
                      {selected.status.replace("_", " ")}
                    </Badge>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <motion.div
                    layout
                    className="rounded-2xl border border-cyan-500/25 bg-cyan-950/20 p-4"
                  >
                    <div className="mb-2 flex items-center gap-2 text-cyan-300">
                      <Mic className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Candidate</span>
                    </div>
                    <p className="text-lg font-medium text-slate-100">{snap.candidateLane}</p>
                  </motion.div>
                  <motion.div
                    layout
                    className="rounded-2xl border border-violet-500/25 bg-violet-950/20 p-4"
                  >
                    <div className="mb-2 flex items-center gap-2 text-violet-300">
                      <Waves className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide">AI stack</span>
                    </div>
                    <p className="text-lg font-medium text-slate-100">{snap.aiLane}</p>
                  </motion.div>
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    { k: "Deepgram", v: fmtMs(snap.deepgramMs) },
                    { k: "GPT", v: fmtMs(snap.gptMs) },
                    { k: "TTS", v: fmtMs(snap.ttsMs) },
                    { k: "Turn total", v: fmtMs(snap.lastTurnTotalMs) },
                  ].map((x) => (
                    <div key={x.k} className="rounded-xl bg-slate-900/80 p-3 ring-1 ring-slate-800">
                      <p className="text-[10px] uppercase text-slate-500">{x.k}</p>
                      <p className="text-xl font-semibold tabular-nums text-slate-100">{x.v}</p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap gap-3">
                  <Badge variant="warning">
                    Interruptions: {snap.interruptionCount}
                  </Badge>
                  <Badge variant="secondary">Probe turns (brain): {snap.probeTurnCount}</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Brain className="h-5 w-5 text-violet-400" />
                  Event feed
                </CardTitle>
                <CardDescription>Newest first — updates every 2s</CardDescription>
              </CardHeader>
              <CardContent className="space-y-0">
                <AnimatePresence initial={false}>
                  {feed.map((e) => (
                    <motion.div
                      key={e.id + e.occurred_at}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="border-b border-slate-800/80 py-2 font-mono text-[11px] last:border-0"
                    >
                      <span className="text-slate-500">
                        {new Date(e.occurred_at).toLocaleTimeString()}
                      </span>{" "}
                      <span className="text-violet-300">{e.event_name}</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {feed.length === 0 && (
                  <p className="text-sm text-slate-500">Waiting for events…</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Live timeline</CardTitle>
              <CardDescription>Recent event density (left → right = time)</CardDescription>
            </CardHeader>
            <CardContent>
              <SessionEventTimeline events={events} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
