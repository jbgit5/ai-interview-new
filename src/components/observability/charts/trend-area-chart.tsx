"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";

export type TrendPoint = { day: string; value: number };

type Props = {
  data: TrendPoint[];
  title: string;
  color?: string;
  valueLabel?: string;
  className?: string;
};

/** Reusable area series — dark theme tuned for observability dashboard */
export function TrendAreaChart({
  data,
  title,
  color = "#8b5cf6",
  valueLabel = "ms",
  className,
}: Props) {
  const gid = useId().replace(/:/g, "");
  return (
    <div className={cn("h-[280px] w-full", className)}>
      <p className="mb-2 text-sm font-medium text-slate-400">{title}</p>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`g-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: "#64748b", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#334155" }}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#334155" }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#0f172a",
              border: "1px solid #334155",
              borderRadius: "10px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#94a3b8" }}
            formatter={(value) => {
              const v = typeof value === "number" ? value : Number(value);
              return [
                Number.isFinite(v) ? `${Math.round(v)} ${valueLabel}` : "—",
                "",
              ];
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={`url(#g-${gid})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
