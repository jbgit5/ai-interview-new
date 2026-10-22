"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Brain,
  GitBranch,
  Mic2,
  PlugZap,
  Radio,
  ShieldAlert,
  TrendingDown,
  Users,
} from "lucide-react";
import type { OverviewKpis, SessionListItem } from "@/lib/observability/types";
import { MetricCard } from "./metric-card";
import { TrendAreaChart } from "./charts/trend-area-chart";
import { RealtimeStatusWidget } from "./realtime-status-widget";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";

function fmtMs(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Math.round(n)} ms`;
}

function fmtPct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n}%`;
}

/** Overview route client — polls KPIs + loads recent sessions for drill-down links */
export function OverviewDashboard() {
  const [kpis, setKpis] = useState<OverviewKpis | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [kr, sr] = await Promise.all([
          fetch("/api/observability/overview?trendDays=14"),
          fetch("/api/observability/sessions?limit=12"),
        ]);
        if (!kr.ok) {
          setErr(kr.status === 401 ? "Sign in required." : "Could not load overview.");
          return;
        }
        const k = (await kr.json()) as OverviewKpis;
        const sJson = sr.ok ? await sr.json() : { sessions: [] };
        if (!cancelled) {
          setKpis(k);
          setSessions(sJson.sessions ?? []);
          setErr(null);
        }
      } catch {
        if (!cancelled) setErr("Network error loading observability data.");
      }
    }
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const wsHealth =
    kpis?.websocketIssueRate == null
      ? "neutral"
      : kpis.websocketIssueRate > 15
        ? "crit"
        : kpis.websocketIssueRate > 5
          ? "warn"
          : "ok";

  return (
    <div className="space-y-8">
      {err && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
          {err}
        </div>
      )}

      {/* Realtime status strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <RealtimeStatusWidget
          title="Active sessions"
          value={kpis ? String(kpis.activeSessions) : "—"}
          status="ok"
          icon={Radio}
          pulse
          subtitle="In-progress interviews"
        />
        <RealtimeStatusWidget
          title="Websocket health"
          value={kpis ? fmtPct(kpis.websocketIssueRate) : "—"}
          subtitle="% of telemetry sessions with LK disconnects"
          status={wsHealth as "ok" | "warn" | "crit" | "neutral"}
          icon={PlugZap}
          pulse={!!kpis?.activeSessions}
        />
        <RealtimeStatusWidget
          title="Session drop-off"
          value={kpis ? fmtPct(kpis.sessionDropPct) : "—"}
          subtitle="Early exits / completed"
          status={
            kpis?.sessionDropPct != null && kpis.sessionDropPct > 20
              ? "warn"
              : "neutral"
          }
          icon={TrendingDown}
        />
        <RealtimeStatusWidget
          title="Brain p95 (rollup)"
          value={kpis?.dailyBrainP95?.length ? fmtMs(kpis.dailyBrainP95[kpis.dailyBrainP95.length - 1]?.value) : "—"}
          subtitle="Last day in series"
          status="neutral"
          icon={Brain}
        />
      </div>

      {/* KPI grid */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="Total interviews"
          value={kpis?.totalInterviews ?? "—"}
          subtitle="All sessions in scope"
          icon={Users}
          live={!!kpis?.activeSessions}
        />
        <MetricCard
          title="Avg STT latency"
          value={fmtMs(kpis?.avgSttLatencyMs ?? null)}
          subtitle="Mean p95 transcript latency"
          icon={Mic2}
        />
        <MetricCard
          title="Avg AI latency"
          value={fmtMs(kpis?.avgAiLatencyMs ?? null)}
          subtitle="Mean brain p95 (LLM path)"
          icon={Brain}
        />
        <MetricCard
          title="Interruption rate"
          value={kpis?.avgInterruptionsPerSession != null ? `${kpis.avgInterruptionsPerSession}` : "—"}
          subtitle="Avg interruptions / session"
          icon={ShieldAlert}
        />
        <MetricCard
          title="Probe count"
          value={kpis?.avgProbesPerSession != null ? `${kpis.avgProbesPerSession}` : "—"}
          subtitle="Avg probes / session"
          icon={GitBranch}
        />
      </div>

      {/* Trends */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Brain latency trend</CardTitle>
            <CardDescription>Daily p95 rollup (organization scope)</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              title=""
              data={kpis?.dailyBrainP95 ?? []}
              color="#a78bfa"
              valueLabel="ms"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Telemetry coverage</CardTitle>
            <CardDescription>Sessions with rollup per day</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              title=""
              data={
                kpis?.dailySessions?.map((d) => ({ day: d.day, value: d.count })) ?? []
              }
              color="#22d3ee"
              valueLabel="sessions"
            />
          </CardContent>
        </Card>
      </div>

      {/* Recent sessions */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Recent sessions</CardTitle>
            <CardDescription>Open analytics or live view for a candidate</CardDescription>
          </div>
          <Link
            href="/dashboard/observability/live"
            className="inline-flex items-center gap-1 text-sm text-violet-400 hover:text-violet-300"
          >
            Live monitor <ArrowRight className="h-4 w-4" />
          </Link>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            {sessions.length === 0 && (
              <p className="text-sm text-slate-500">No sessions yet.</p>
            )}
            {sessions.map((s, idx) => (
              <motion.div
                key={s.session_id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
                className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-200">
                    {s.candidate_name ?? "Candidate"}
                  </p>
                  <p className="truncate text-xs text-slate-500">{s.job_title}</p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {s.status.replace("_", " ")}
                  </Badge>
                  <Link
                    href={`/dashboard/observability/sessions/${s.session_id}`}
                    className="rounded-lg bg-violet-600/20 px-2.5 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/30"
                  >
                    Analytics
                  </Link>
                </div>
              </motion.div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
