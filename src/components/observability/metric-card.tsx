"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

type MetricCardProps = {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  /** 0–1 trend delta for subtle color */
  trend?: "up" | "down" | "neutral";
  className?: string;
  live?: boolean;
};

/** KPI surface — glass card with optional live pulse */
export function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend = "neutral",
  className,
  live,
}: MetricCardProps) {
  const trendColor =
    trend === "up" ? "text-emerald-400" : trend === "down" ? "text-rose-400" : "text-slate-400";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-slate-800/90 bg-gradient-to-br from-slate-900/90 to-slate-950/95 p-5 shadow-lg shadow-black/30",
        className
      )}
    >
      {live && (
        <span className="absolute right-4 top-4 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{title}</p>
          <p className={cn("mt-2 text-3xl font-semibold tabular-nums tracking-tight text-slate-50")}>
            {value}
          </p>
          {subtitle && <p className={cn("mt-1 text-xs", trendColor)}>{subtitle}</p>}
        </div>
        <div className="rounded-xl bg-violet-500/15 p-2.5 ring-1 ring-violet-500/20">
          <Icon className="h-5 w-5 text-violet-300" aria-hidden />
        </div>
      </div>
    </motion.div>
  );
}
