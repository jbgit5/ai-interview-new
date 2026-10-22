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
import { cn } from "@/lib/utils";

export type BarPoint = { name: string; avg: number; p95: number };

type Props = {
  data: BarPoint[];
  className?: string;
};

/** Side-by-side avg vs p95 for vendor latency comparison */
export function BarComparisonChart({ data, className }: Props) {
  return (
    <div className={cn("h-[300px] w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="name"
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            axisLine={{ stroke: "#334155" }}
          />
          <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={{ stroke: "#334155" }} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#0f172a",
              border: "1px solid #334155",
              borderRadius: "10px",
            }}
            formatter={(value) => {
              const v = typeof value === "number" ? value : Number(value);
              return [Number.isFinite(v) ? `${Math.round(v)} ms` : "—", ""];
            }}
          />
          <Bar dataKey="avg" name="Avg" fill="#6366f1" radius={[4, 4, 0, 0]} />
          <Bar dataKey="p95" name="p95" fill="#a78bfa" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
