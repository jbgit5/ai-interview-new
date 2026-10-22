"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

type Props = {
  title: string;
  value: string;
  status: "ok" | "warn" | "crit" | "neutral";
  icon: LucideIcon;
  /** When true, show pulsing live marker */
  pulse?: boolean;
  subtitle?: string;
  className?: string;
};

const ring: Record<Props["status"], string> = {
  ok: "from-emerald-500/30 to-emerald-600/5",
  warn: "from-amber-500/30 to-amber-600/5",
  crit: "from-rose-500/30 to-rose-600/5",
  neutral: "from-slate-500/20 to-slate-700/5",
};

/** Compact realtime strip: health / websocket / vendor style signals */
export function RealtimeStatusWidget({
  title,
  value,
  status,
  icon: Icon,
  pulse,
  subtitle,
  className,
}: Props) {
  return (
    <motion.div
      layout
      className={cn(
        "relative flex items-center gap-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 p-4",
        className
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-br opacity-90",
          ring[status]
        )}
      />
      <div className="relative flex flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          {pulse && (
            <span className="relative flex h-2 w-2">
              <motion.span
                className="absolute inline-flex h-full w-full rounded-full bg-emerald-400"
                animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0.15, 0.6] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          )}
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        </div>
        <p className="relative text-lg font-semibold text-slate-100">{value}</p>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      <div className="relative rounded-xl bg-slate-800/80 p-3 ring-1 ring-slate-700/80">
        <Icon className="h-5 w-5 text-slate-200" />
      </div>
    </motion.div>
  );
}
