"use client";

import { useEffect, useState } from "react";
import { Activity, BarChart2, HeartPulse, SlidersHorizontal } from "lucide-react";
import { TrendAreaChart } from "./charts/trend-area-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "./metric-card";

type TrendsPayload = {
  brainP95: { day: string; value: number }[];
  interruptions: { day: string; value: number }[];
  probes: { day: string; value: number }[];
  health: { day: string; score: number }[];
};

function lastDelta(series: { day: string; value: number }[] | { day: string; score: number }[]) {
  if (series.length < 2) return null;
  const a = series[series.length - 2];
  const b = series[series.length - 1];
  const av = "value" in a ? a.value : a.score;
  const bv = "value" in b ? b.value : b.score;
  return bv - av;
}

/** Longitudinal quality view — latency, interruptions, probes, composite health */
export function ImprovementTrendsDashboard() {
  const [trends, setTrends] = useState<TrendsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/observability/trends?days=60");
        if (!r.ok) {
          setErr("Could not load trends.");
          return;
        }
        const t = (await r.json()) as TrendsPayload;
        if (!cancelled) {
          setTrends(t);
          setErr(null);
        }
      } catch {
        if (!cancelled) setErr("Network error.");
      }
    })();
    const id = setInterval(async () => {
      const r = await fetch("/api/observability/trends?days=60");
      if (r.ok && !cancelled) setTrends((await r.json()) as TrendsPayload);
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const brain = trends?.brainP95 ?? [];
  const intr = trends?.interruptions ?? [];
  const probes = trends?.probes ?? [];
  const health = trends?.health ?? [];

  const brainDelta = lastDelta(brain);
  const intrDelta = lastDelta(intr as { day: string; value: number }[]);
  const probeDelta = lastDelta(probes);

  return (
    <div className="space-y-8">
      {err && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-2 text-sm text-amber-100">
          {err}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Brain p95 (latest Δ)"
          value={brainDelta != null ? `${brainDelta > 0 ? "+" : ""}${brainDelta.toFixed(1)} ms` : "—"}
          subtitle="Day over day (rollup)"
          icon={Activity}
        />
        <MetricCard
          title="Interruptions Δ"
          value={intrDelta != null ? `${intrDelta > 0 ? "+" : ""}${intrDelta.toFixed(1)}` : "—"}
          subtitle="Total interruptions / day shift"
          icon={SlidersHorizontal}
        />
        <MetricCard
          title="Avg probes Δ"
          value={probeDelta != null ? `${probeDelta > 0 ? "+" : ""}${probeDelta.toFixed(2)}` : "—"}
          subtitle="Probe effectiveness proxy"
          icon={BarChart2}
        />
        <MetricCard
          title="Health score"
          value={
            health.length ? `${health[health.length - 1]?.score ?? "—"}` : "—"
          }
          subtitle="Derived from latency rollups"
          icon={HeartPulse}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Latency improvement</CardTitle>
            <CardDescription>Daily brain p95 average — lower is better</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              title=""
              data={brain.map((b) => ({ day: b.day, value: b.value }))}
              color="#a78bfa"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Interruption load</CardTitle>
            <CardDescription>Sum of interruptions on completed days</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              title=""
              data={intr.map((b) => ({ day: b.day, value: b.value }))}
              color="#fb7185"
              valueLabel="count"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Probe cadence</CardTitle>
            <CardDescription>Average probes per session</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              title=""
              data={probes.map((b) => ({ day: b.day, value: b.value }))}
              color="#34d399"
              valueLabel="avg"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>System health</CardTitle>
            <CardDescription>Heuristic score from latency trajectory</CardDescription>
          </CardHeader>
          <CardContent>
            <TrendAreaChart
              title=""
              data={health.map((h) => ({ day: h.day, value: h.score }))}
              color="#38bdf8"
              valueLabel="score"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
