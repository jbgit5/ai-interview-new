"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import type { LatencyChartRow } from "@/lib/observability/types";

type Props = {
  data: LatencyChartRow[];
  className?: string;
};

/** Multi-series latency — STT / LLM / TTS on aligned labels (e.g. turn or time bucket). */
export function LatencyMultiLineChart({ data, className }: Props) {
  return (
    <div className={cn("h-[300px] w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "#94a3b8", fontSize: 10 }}
            axisLine={{ stroke: "#334155" }}
            interval="preserveStartEnd"
          />
          <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#334155" }} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#0f172a",
              border: "1px solid #334155",
              borderRadius: "10px",
              fontSize: "12px",
            }}
            formatter={(value) => {
              if (value == null) return "—";
              const v = typeof value === "number" ? value : Number(value);
              return Number.isFinite(v) ? `${Math.round(v)} ms` : "—";
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="stt" name="STT" stroke="#22d3ee" strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="llm" name="GPT" stroke="#a78bfa" strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="tts" name="TTS" stroke="#34d399" strokeWidth={2} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
