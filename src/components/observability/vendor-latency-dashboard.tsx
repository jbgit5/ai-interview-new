"use client";

import { useEffect, useMemo, useState } from "react";
import { Cpu, Radio, Wifi } from "lucide-react";
import type { VendorStats } from "@/lib/observability/types";
import { BarComparisonChart, type BarPoint } from "./charts/bar-comparison-chart";
import { MetricCard } from "./metric-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function fmtMs(n: number | null | undefined) {
  if (n == null) return "—";
  return `${Math.round(n)} ms`;
}

/** Compare Deepgram / OpenAI / LiveKit — latency bars + reliability counters */
export function VendorLatencyDashboard() {
  const [vendors, setVendors] = useState<VendorStats[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/observability/vendors?sinceDays=30");
        if (!r.ok) {
          setErr("Could not load vendors.");
          return;
        }
        const data = (await r.json()) as { vendors?: VendorStats[] };
        if (!cancelled) {
          setVendors(data.vendors ?? []);
          setErr(null);
        }
      } catch {
        if (!cancelled) setErr("Network error.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const barData: BarPoint[] = useMemo(() => {
    return vendors.map((v) => ({
      name:
        v.vendor === "stt"
          ? "STT"
          : v.vendor === "openai"
            ? "OpenAI"
            : "LiveKit",
      avg: v.avgLatencyMs ?? 0,
      p95: v.p95LatencyMs ?? 0,
    }));
  }, [vendors]);

  const openai = vendors.find((v) => v.vendor === "openai");
  const stt = vendors.find((v) => v.vendor === "stt");
  const lk = vendors.find((v) => v.vendor === "livekit");

  return (
    <div className="space-y-8">
      {err && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-2 text-sm text-amber-100">
          {err}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          title="OpenAI — avg latency"
          value={fmtMs(openai?.avgLatencyMs)}
          subtitle="GPT + TTS blended (see query)"
          icon={Cpu}
        />
        <MetricCard
          title="STT events sampled"
          value={stt?.samples ?? "—"}
          subtitle="STT-tagged events (30d)"
          icon={Radio}
        />
        <MetricCard
          title="LiveKit reconnects"
          value={lk?.reconnectsOrRetries ?? "—"}
          subtitle="Connection retries"
          icon={Wifi}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Latency profile</CardTitle>
          <CardDescription>Average vs p95 where latency dimensions exist (STT lacks roll-up here)</CardDescription>
        </CardHeader>
        <CardContent>
          <BarComparisonChart data={barData} />
          <p className="mt-3 text-xs text-slate-500">
            LiveKit rows surface reconnects / disconnects rather than milliseconds — bars may read 0.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {vendors.map((v) => (
          <Card key={v.vendor}>
            <CardHeader>
              <CardTitle className="text-base">{v.label}</CardTitle>
              <CardDescription>{v.vendor}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Avg ms</span>
                <span className="font-mono text-slate-100">{fmtMs(v.avgLatencyMs)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>p95 ms</span>
                <span className="font-mono text-slate-100">{fmtMs(v.p95LatencyMs)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Reconnects / retries</span>
                <span className="font-mono text-slate-100">{v.reconnectsOrRetries}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Failures</span>
                <span className="font-mono text-rose-300">{v.failures}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Samples</span>
                <span className="font-mono text-slate-300">{v.samples}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

    </div>
  );
}
